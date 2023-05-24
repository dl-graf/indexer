import { Counter, Gauge, Histogram } from 'prom-client'
import axios from 'axios'
import {
  Logger,
  timer,
  BytesWriter,
  toAddress,
  formatGRT,
  Address,
  Metrics,
} from '@graphprotocol/common-ts'
import {
  Allocation,
  AllocationReceipt,
  indexerError,
  IndexerErrorCode,
  QueryFeeModels,
  Voucher,
  ensureAllocationSummary,
  TransactionManager,
} from '..'
import { DHeap } from '@thi.ng/heaps'
import { BigNumber, BigNumberish, Contract } from 'ethers'
import { Op } from 'sequelize'
import pReduce from 'p-reduce'

// Receipts are collected with a delay of 20 minutes after
// the corresponding allocation was closed
const RECEIPT_COLLECT_DELAY = 1200_000

interface AllocationReceiptsBatch {
  receipts: AllocationReceipt[]
  timeout: number
}

export interface PartialVoucher {
  allocation: string // (0x-prefixed hex)
  fees: string // (0x-prefixed hex)
  signature: string // (0x-prefixed hex)
  receipt_id_min: string // (0x-prefixed hex)
  receipt_id_max: string // (0x-prefixed hex)
}

interface ReceiptMetrics {
  receiptsToCollect: Gauge<string>
  failedReceipts: Counter<string>
  partialVouchersToExchange: Gauge<string>
  receiptsCollectDuration: Histogram<string>
  vouchers: Counter<string>
  successVoucherRedeems: Counter<string>
  invalidVoucherRedeems: Counter<string>
  failedVoucherRedeems: Counter<string>
  vouchersRedeemDuration: Histogram<string>
  vouchersBatchRedeemSize: Gauge<never>
  voucherCollectedFees: Gauge<string>
}

export interface AllocationReceiptCollectorOptions {
  logger: Logger
  metrics: Metrics
  transactionManager: TransactionManager
  allocationExchange: Contract
  models: QueryFeeModels
  gatewayEndpoint: string
  voucherRedemptionThreshold: BigNumber
  voucherRedemptionBatchThreshold: BigNumber
  voucherRedemptionMaxBatchSize: number
}

export interface ReceiptCollector {
  rememberAllocations(actionID: number, allocationIDs: Address[]): Promise<boolean>
  collectReceipts(actionID: number, allocation: Allocation): Promise<boolean>
}

export class AllocationReceiptCollector implements ReceiptCollector {
  private logger: Logger
  private metrics: ReceiptMetrics
  private models: QueryFeeModels
  private transactionManager: TransactionManager
  private allocationExchange: Contract
  private collectEndpoint: URL
  private partialVoucherEndpoint: URL
  private voucherEndpoint: URL
  private receiptsToCollect!: DHeap<AllocationReceiptsBatch>
  private voucherRedemptionThreshold: BigNumber
  private voucherRedemptionBatchThreshold: BigNumber
  private voucherRedemptionMaxBatchSize: number

  constructor({
    logger,
    metrics,
    transactionManager,
    models,
    gatewayEndpoint,
    allocationExchange,
    voucherRedemptionThreshold,
    voucherRedemptionBatchThreshold,
    voucherRedemptionMaxBatchSize,
  }: AllocationReceiptCollectorOptions) {
    this.logger = logger.child({ component: 'AllocationReceiptCollector' })
    this.metrics = registerReceiptMetrics(metrics)
    this.transactionManager = transactionManager
    this.models = models
    this.allocationExchange = allocationExchange

    // Process Gateway routes
    const gatewayUrls = processGatewayRoutes(gatewayEndpoint)
    this.collectEndpoint = gatewayUrls.collectReceipts
    this.voucherEndpoint = gatewayUrls.voucher
    this.partialVoucherEndpoint = gatewayUrls.partialVoucher

    this.voucherRedemptionThreshold = voucherRedemptionThreshold
    this.voucherRedemptionBatchThreshold = voucherRedemptionBatchThreshold
    this.voucherRedemptionMaxBatchSize = voucherRedemptionMaxBatchSize

    this.startReceiptCollecting()
    this.startVoucherProcessing()
  }

  async rememberAllocations(
    actionID: number,
    allocationIDs: Address[],
  ): Promise<boolean> {
    const logger = this.logger.child({
      action: actionID,
      allocations: allocationIDs,
    })

    try {
      logger.info('Remember allocations for collecting receipts later')

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await this.models.allocationSummaries.sequelize!.transaction(
        async (transaction) => {
          for (const allocation of allocationIDs) {
            const [summary] = await ensureAllocationSummary(
              this.models,
              allocation,
              transaction,
            )
            await summary.save()
          }
        },
      )
      return true
    } catch (err) {
      logger.error(`Failed to remember allocations for collecting receipts later`, {
        err: indexerError(IndexerErrorCode.IE056, err),
      })
      return false
    }
  }

  async collectReceipts(actionID: number, allocation: Allocation): Promise<boolean> {
    const logger = this.logger.child({
      action: actionID,
      allocation: allocation.id,
      deployment: allocation.subgraphDeployment.id.display,
    })

    try {
      logger.debug(`Queue allocation receipts for collecting`, { actionID, allocation })

      const now = new Date()

      const receipts =
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        await this.models.allocationReceipts.sequelize!.transaction(
          async (transaction) => {
            // Update the allocation summary
            await this.models.allocationSummaries.update(
              { closedAt: now },
              {
                where: { allocation: allocation.id },
                transaction,
              },
            )

            // Return all receipts for the just-closed allocation
            return this.models.allocationReceipts.findAll({
              where: { allocation: allocation.id },
              order: ['id'],
              transaction,
            })
          },
        )

      this.metrics.receiptsToCollect.set(
        { allocation: receipts[0].allocation },
        receipts.length,
      )
      if (receipts.length <= 0) {
        logger.debug(`No receipts to collect for allocation`, { actionID, allocation })
        return false
      }

      const timeout = now.valueOf() + RECEIPT_COLLECT_DELAY

      // Collect the receipts for this allocation in a bit
      this.receiptsToCollect.push({
        receipts,
        timeout,
      })
      logger.info(`Successfully queued allocation receipts for collecting`, {
        receipts: receipts.length,
        timeout: new Date(timeout).toLocaleString(),
        actionID,
        allocation,
      })
      return true
    } catch (err) {
      const error = indexerError(IndexerErrorCode.IE053, err)
      this.metrics.failedReceipts.inc({ allocation: allocation.id })
      this.logger.error(`Failed to queue allocation receipts for collecting`, {
        error,
        actionID,
        allocation,
      })
      throw error
    }
  }

  private startReceiptCollecting() {
    this.receiptsToCollect = new DHeap<AllocationReceiptsBatch>(null, {
      compare: (t1, t2) => t1.timeout - t2.timeout,
    })

    const hasReceiptsReadyForCollecting = () => {
      const batch = this.receiptsToCollect.peek()
      return batch && batch.timeout <= Date.now()
    }

    // Check if there's another batch of receipts to collect every 10s
    timer(10_000).pipe(async () => {
      while (hasReceiptsReadyForCollecting()) {
        // Remove the batch from the processing queue
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const batch = this.receiptsToCollect.pop()!

        // If the array is empty we cannot know what allocation this group
        // belongs to. Should this assertion ever fail, then there is a
        // programmer error where empty batches are pushed to the
        // `receiptsToCollect` queue.
        console.assert(batch.receipts.length > 0)

        // Collect the receipts now
        await this.obtainReceiptsVoucher(batch.receipts)
      }
    })
  }

  private startVoucherProcessing() {
    timer(30_000).pipe(async () => {
      const pendingVouchers = await this.pendingVouchers() // Ordered by value

      const logger = this.logger.child({})

      const vouchers = await pReduce(
        pendingVouchers,
        async (results, voucher) => {
          if (await this.allocationExchange.allocationsRedeemed(voucher.allocation)) {
            try {
              await this.models.vouchers.destroy({
                where: { allocation: voucher.allocation },
              })
              logger.warn(
                `Query fee voucher for allocation already redeemed, deleted local voucher copy`,
                { allocation: voucher.allocation },
              )
            } catch (err) {
              logger.warn(`Failed to delete local vouchers copy, will try again later`, {
                err,
                allocation: voucher.allocation,
              })
            }
            return results
          }
          if (BigNumber.from(voucher.amount).lt(this.voucherRedemptionThreshold)) {
            results.belowThreshold.push(voucher)
          } else {
            results.eligible.push(voucher)
          }
          return results
        },
        { belowThreshold: <Voucher[]>[], eligible: <Voucher[]>[] },
      )

      if (vouchers.belowThreshold.length > 0) {
        const totalValueGRT = formatGRT(
          vouchers.belowThreshold.reduce(
            (total, voucher) => total.add(BigNumber.from(voucher.amount)),
            BigNumber.from(0),
          ),
        )
        logger.info(`Query vouchers below the redemption threshold`, {
          hint: 'If you would like to redeem vouchers like this, reduce the voucher redemption threshold',
          voucherRedemptionThreshold: formatGRT(this.voucherRedemptionThreshold),
          belowThresholdCount: vouchers.belowThreshold.length,
          totalValueGRT,
          allocations: vouchers.belowThreshold.map((voucher) => voucher.allocation),
        })
      }

      // If there are no eligible vouchers then bail
      if (vouchers.eligible.length === 0) return

      // Already ordered by value
      const voucherBatch = vouchers.eligible.slice(0, this.voucherRedemptionMaxBatchSize),
        batchValueGRT = voucherBatch.reduce(
          (total, voucher) => total.add(BigNumber.from(voucher.amount)),
          BigNumber.from(0),
        )

      if (batchValueGRT.gt(this.voucherRedemptionBatchThreshold)) {
        this.metrics.vouchersBatchRedeemSize.set(voucherBatch.length)
        logger.info(`Query voucher batch is ready for redemption`, {
          batchSize: voucherBatch.length,
          voucherRedemptionMaxBatchSize: this.voucherRedemptionMaxBatchSize,
          voucherRedemptionBatchThreshold: formatGRT(
            this.voucherRedemptionBatchThreshold,
          ),
          batchValueGRT: formatGRT(batchValueGRT),
        })
        await this.submitVouchers(voucherBatch)
      } else {
        logger.info(`Query voucher batch value too low for redemption`, {
          batchSize: voucherBatch.length,
          voucherRedemptionMaxBatchSize: this.voucherRedemptionMaxBatchSize,
          voucherRedemptionBatchThreshold: formatGRT(
            this.voucherRedemptionBatchThreshold,
          ),
          batchValueGRT: formatGRT(batchValueGRT),
        })
      }
    })
  }

  private async pendingVouchers(): Promise<Voucher[]> {
    return this.models.vouchers.findAll({
      order: [['amount', 'DESC']], // sorted by highest value to maximise the value of the batch
      limit: this.voucherRedemptionMaxBatchSize, // limit the number of vouchers to the max batch size
    })
  }

  private encodeReceiptBatch(receipts: AllocationReceipt[]): BytesWriter {
    // Encode the receipt batch to a buffer
    // [allocationId, receipts[]] (in bytes)
    const encodedReceipts = new BytesWriter(20 + receipts.length * 112)
    encodedReceipts.writeHex(receipts[0].allocation)
    for (const receipt of receipts) {
      // [fee, id, signature]
      const fee = BigNumber.from(receipt.fees).toHexString()
      const feePadding = 33 - fee.length / 2
      encodedReceipts.writeZeroes(feePadding)
      encodedReceipts.writeHex(fee)
      encodedReceipts.writeHex(receipt.id)
      encodedReceipts.writeHex(receipt.signature)
    }
    return encodedReceipts
  }

  private async obtainReceiptsVoucher(receipts: AllocationReceipt[]): Promise<void> {
    const allocation = receipts[0].allocation
    const logger = this.logger.child({
      allocation,
    })
    // Gross underestimated number of receipts the gateway take at once
    const receiptsThreshold = 25_000
    let response
    try {
      logger.info(`Collect receipts for allocation`, {
        receipts: receipts.length,
      })
      const stopTimer = this.metrics.receiptsCollectDuration.startTimer({ allocation })

      // All receipts can fit the gateway, make a single-shot collection
      if (receipts.length <= receiptsThreshold) {
        const encodedReceipts = this.encodeReceiptBatch(receipts)

        // Exchange the receipts for a voucher signed by the counterparty (aka the client)
        response = await axios.post(
          this.collectEndpoint.toString(),
          encodedReceipts.unwrap().buffer,
          { headers: { 'Content-Type': 'application/octet-stream' } },
        )
      } else {
        // Split receipts in batches and collect partial vouchers
        const partialVouchers: Array<PartialVoucher> = []
        for (let i = 0; i < receipts.length; i += receiptsThreshold) {
          const partialReceipts = receipts.slice(
            i,
            Math.min(i + receiptsThreshold, receipts.length),
          )
          const encodedReceipts = this.encodeReceiptBatch(partialReceipts)

          // Exchange the receipts for a partial voucher signed by the counterparty (aka the client)
          response = await axios.post(
            this.partialVoucherEndpoint.toString(),
            encodedReceipts.unwrap().buffer,
            { headers: { 'Content-Type': 'application/octet-stream' } },
          )
          const partialVoucher = response.data as PartialVoucher
          partialVouchers.push(partialVoucher)
        }

        this.metrics.partialVouchersToExchange.set({ allocation }, partialVouchers.length)
        logger.debug(`Partial vouchers to exchange`, {
          partialVouchers: partialVouchers.length,
          hexStringLength: partialVouchers[0].allocation,
        })

        const encodedPartialVouchers = encodePartialVouchers(partialVouchers)

        // Exchange the partial vouchers for a voucher
        response = await axios.post(
          this.voucherEndpoint.toString(),
          encodedPartialVouchers.unwrap().buffer,
          { headers: { 'Content-Type': 'application/octet-stream' } },
        )
      }

      const voucher = response.data as {
        allocation: string
        amount: string
        signature: string
      }
      this.metrics.vouchers.inc({
        allocation,
      })
      this.metrics.voucherCollectedFees.set({ allocation }, parseFloat(voucher.amount))

      // Replace the receipts with the voucher in one db transaction;
      // should this fail, we'll try to collect these receipts again
      // later
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await this.models.vouchers.sequelize!.transaction(async (transaction) => {
        logger.debug(`Removing collected receipts from the database`, {
          receipts: receipts.length,
        })

        // Remove all receipts in the batch from the database
        await this.models.allocationReceipts.destroy({
          where: {
            id: receipts.map((receipt) => receipt.id),
          },
          transaction,
        })

        logger.debug(`Add voucher received in exchange for receipts to the database`)

        // Update the query fees tracked against the allocation
        const [summary] = await ensureAllocationSummary(
          this.models,
          toAddress(voucher.allocation),
          transaction,
        )
        summary.collectedFees = BigNumber.from(summary.collectedFees)
          .add(voucher.amount)
          .toString()
        await summary.save({ transaction })

        // Add the voucher to the database
        await this.models.vouchers.findOrCreate({
          where: { allocation: toAddress(voucher.allocation) },
          defaults: {
            allocation: toAddress(voucher.allocation),
            amount: voucher.amount,
            signature: voucher.signature,
          },
          transaction,
        })
      })
      stopTimer()
    } catch (err) {
      logger.error(
        `Failed to collect receipts in exchange for an on-chain query fee voucher`,
        { err: indexerError(IndexerErrorCode.IE054, err) },
      )
    }
  }

  private async submitVouchers(vouchers: Voucher[]): Promise<void> {
    const logger = this.logger.child({
      voucherBatchSize: vouchers.length,
    })

    logger.info(`Redeem query voucher batch on chain`, {
      allocations: vouchers.map((voucher) => voucher.allocation),
    })
    const stopTimer = this.metrics.vouchersRedeemDuration.startTimer({
      allocation: vouchers[0].allocation,
    })

    const hexPrefix = (bytes: string): string =>
      bytes.startsWith('0x') ? bytes : `0x${bytes}`

    const onchainVouchers = vouchers.map((voucher) => {
      return {
        allocationID: hexPrefix(voucher.allocation),
        amount: voucher.amount,
        signature: hexPrefix(voucher.signature),
      }
    })

    try {
      // Submit the voucher on chain
      const txReceipt = await this.transactionManager.executeTransaction(
        () => this.allocationExchange.estimateGas.redeemMany(onchainVouchers),
        async (gasLimit: BigNumberish) =>
          this.allocationExchange.redeemMany(onchainVouchers, {
            gasLimit,
          }),
        logger.child({ action: 'redeemMany' }),
      )

      if (txReceipt === 'paused' || txReceipt === 'unauthorized') {
        this.metrics.invalidVoucherRedeems.inc({ allocation: vouchers[0].allocation })
        return
      }

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await this.models.allocationSummaries.sequelize!.transaction(
        async (transaction) => {
          for (const voucher of vouchers) {
            const [summary] = await ensureAllocationSummary(
              this.models,
              toAddress(voucher.allocation),
              transaction,
            )
            summary.withdrawnFees = BigNumber.from(summary.withdrawnFees)
              .add(voucher.amount)
              .toString()
            await summary.save()
          }
        },
      )
    } catch (err) {
      this.metrics.failedVoucherRedeems.inc({ allocation: vouchers[0].allocation })
      logger.error(`Failed to redeem query fee voucher`, {
        err: indexerError(IndexerErrorCode.IE055, err),
      })
      return
    }
    stopTimer()

    // Remove the now obsolete voucher from the database
    logger.info(`Successfully redeemed query fee voucher, delete local copy`)
    try {
      await this.models.vouchers.destroy({
        where: { allocation: vouchers.map((voucher) => voucher.allocation) },
      })
      this.metrics.successVoucherRedeems.inc({ allocation: vouchers[0].allocation })
      logger.info(`Successfully deleted local voucher copy`)
    } catch (err) {
      logger.warn(`Failed to delete local voucher copy, will try again later`, {
        err,
      })
    }
  }

  public async queuePendingReceiptsFromDatabase(): Promise<void> {
    // Obtain all closed allocations
    const closedAllocations = await this.models.allocationSummaries.findAll({
      where: { closedAt: { [Op.not]: null } },
    })

    // Create a receipts batch for each of these allocations
    const batches = new Map<string, AllocationReceiptsBatch>(
      closedAllocations.map((summary) => [
        summary.allocation,
        {
          timeout: summary.closedAt.valueOf() + RECEIPT_COLLECT_DELAY,
          receipts: [],
        },
      ]),
    )

    // Obtain all receipts for these allocations
    const uncollectedReceipts = await this.models.allocationReceipts.findAll({
      where: {
        allocation: closedAllocations.map((summary) => summary.allocation),
      },
      order: ['id'],
    })

    // Add receipts into the right batches
    for (const receipt of uncollectedReceipts) {
      const batch = batches.get(receipt.allocation)

      // We can safely assume that we only fetched receipts matching the
      // allocations; just asserting this here to be _really_ sure
      console.assert(batch !== undefined)
      batch?.receipts.push(receipt)
    }

    // Queue all batches of uncollected receipts
    for (const batch of batches.values()) {
      if (batch.receipts.length > 0) {
        this.logger.info(
          `Queue allocation receipts for collecting again after a restart`,
          {
            allocation: batch.receipts[0].allocation,
            receipts: batch.receipts.length,
          },
        )
        this.receiptsToCollect.push(batch)
      }
    }
  }
}

export function encodePartialVouchers(partialVouchers: PartialVoucher[]): BytesWriter {
  // Take the partial vouchers and request for a full voucher
  // [allocationId, partialVouchers[]] (in bytes)
  // A voucher request needs allocation id which all partial vouchers shares,
  // and a list of attributes (fees, signature, receipt id min, and receipt id max)
  // from each partial voucher, all in form of 0x-prefixed hex string (32bytes)
  const encodedPartialVouchers = new BytesWriter(20 + 128 * partialVouchers.length)

  encodedPartialVouchers.writeHex(partialVouchers[0].allocation)
  for (const partialVoucher of partialVouchers) {
    // [fees, signature, receipt_id_min, receipt_id_max] as 0x-prefixed string list
    const fee = BigNumber.from(partialVoucher.fees).toHexString()
    // We slice the hex string to remove the "0x" prefix from the byte length calculation
    const feeByteLength = fee.slice(2).length / 2
    const feePadding = 33 - feeByteLength
    encodedPartialVouchers.writeZeroes(feePadding)
    encodedPartialVouchers.writeHex(fee)
    encodedPartialVouchers.writeHex(partialVoucher.signature)
    encodedPartialVouchers.writeHex(partialVoucher.receipt_id_min)
    encodedPartialVouchers.writeHex(partialVoucher.receipt_id_max)
  }
  return encodedPartialVouchers
}

const registerReceiptMetrics = (metrics: Metrics) => ({
  receiptsToCollect: new metrics.client.Gauge({
    name: 'indexer_agent_receipts_to_collect',
    help: 'Individual receipts to collect',
    registers: [metrics.registry],
    labelNames: ['allocation'],
  }),

  failedReceipts: new metrics.client.Counter({
    name: 'indexer_agent_receipts_failed',
    help: 'Failed to queue receipts to collect',
    registers: [metrics.registry],
    labelNames: ['allocation'],
  }),

  partialVouchersToExchange: new metrics.client.Gauge({
    name: 'indexer_agent_vouchers_to_exchange',
    help: 'Individual partial vouchers to exchange',
    registers: [metrics.registry],
    labelNames: ['allocation'],
  }),

  receiptsCollectDuration: new metrics.client.Histogram({
    name: 'indexer_agent_receipts_exchange_duration',
    help: 'Duration of processing and exchanging receipts to voucher',
    registers: [metrics.registry],
    labelNames: ['allocation'],
  }),

  vouchers: new metrics.client.Counter({
    name: 'indexer_agent_vouchers',
    help: 'Individual vouchers to redeem',
    registers: [metrics.registry],
    labelNames: ['allocation'],
  }),

  successVoucherRedeems: new metrics.client.Counter({
    name: 'indexer_agent_voucher_exchanges_ok',
    help: 'Successfully redeemed vouchers',
    registers: [metrics.registry],
    labelNames: ['allocation'],
  }),

  invalidVoucherRedeems: new metrics.client.Counter({
    name: 'indexer_agent_voucher_exchanges_invalid',
    help: 'Invalid vouchers redeems - tx paused or unauthorized',
    registers: [metrics.registry],
    labelNames: ['allocation'],
  }),

  failedVoucherRedeems: new metrics.client.Counter({
    name: 'indexer_agent_voucher_redeems_failed',
    help: 'Failed redeems for vouchers',
    registers: [metrics.registry],
    labelNames: ['allocation'],
  }),

  vouchersRedeemDuration: new metrics.client.Histogram({
    name: 'indexer_agent_vouchers_redeem_duration',
    help: 'Duration of redeeming vouchers',
    registers: [metrics.registry],
    labelNames: ['allocation'],
  }),

  vouchersBatchRedeemSize: new metrics.client.Gauge({
    name: 'indexer_agent_vouchers_redeem',
    help: 'Size of redeeming batched vouchers',
    registers: [metrics.registry],
  }),

  voucherCollectedFees: new metrics.client.Gauge({
    name: 'indexer_agent_voucher_collected_fees',
    help: 'Amount of query fees collected for a voucher',
    registers: [metrics.registry],
    labelNames: ['allocation'],
  }),
})

interface GatewayRoutes {
  collectReceipts: URL
  voucher: URL
  partialVoucher: URL
}

function processGatewayRoutes(input: string): GatewayRoutes {
  const GATEWAY_ROUTES = {
    collectReceipts: 'collect-receipts',
    voucher: 'voucher',
    partialVoucher: 'partial-voucher',
  }

  // Strip existing information except for protocol and host
  const inputURL = new URL(input)
  const base = `${inputURL.protocol}//${inputURL.host}`

  function route(pathname: string): URL {
    const url = new URL(base)
    url.pathname = pathname
    return url
  }

  return {
    collectReceipts: route(GATEWAY_ROUTES.collectReceipts),
    voucher: route(GATEWAY_ROUTES.voucher),
    partialVoucher: route(GATEWAY_ROUTES.partialVoucher),
  }
}
