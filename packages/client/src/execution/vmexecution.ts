import {
  DBSaveLookups,
  DBSetBlockOrHeader,
  DBSetHashToNumber,
  DBSetTD,
} from '@ethereumjs/blockchain'
import { ConsensusType, Hardfork } from '@ethereumjs/common'
import { getGenesis } from '@ethereumjs/genesis'
import { CacheType, DefaultStateManager } from '@ethereumjs/statemanager'
import { Trie } from '@ethereumjs/trie'
import {
  BIGINT_0,
  BIGINT_1,
  LevelDB,
  Lock,
  ValueEncoding,
  bytesToHex,
  equalsBytes,
} from '@ethereumjs/util'
import { VM } from '@ethereumjs/vm'

import { Event } from '../types'
import { short } from '../util'
import { debugCodeReplayBlock } from '../util/debug'

import { Execution } from './execution'
import { ReceiptsManager } from './receipt'

import type { ExecutionOptions } from './execution'
import type { Block } from '@ethereumjs/block'
import type { RunBlockOpts, TxReceipt } from '@ethereumjs/vm'

export class VMExecution extends Execution {
  private _lock = new Lock()

  public vm: VM
  public hardfork: string = ''

  public receiptsManager?: ReceiptsManager
  private pendingReceipts?: Map<string, TxReceipt[]>
  private vmPromise?: Promise<number | null>

  /** Maximally tolerated block time before giving a warning on console */
  private MAX_TOLERATED_BLOCK_TIME = 12

  /**
   * Interval for client execution stats output (in ms)
   * for debug log level
   *
   */
  private STATS_INTERVAL = 1000 * 90 // 90 seconds

  private _statsInterval: NodeJS.Timeout | undefined /* global NodeJS */
  private _statsVm: VM | undefined

  /**
   * Create new VM execution module
   */
  constructor(options: ExecutionOptions) {
    super(options)

    if (this.config.vm === undefined) {
      const trie = new Trie({
        db: new LevelDB(this.stateDB),
        useKeyHashing: true,
        cacheSize: this.config.trieCache,
        valueEncoding: options.config.useStringValueTrieDB
          ? ValueEncoding.String
          : ValueEncoding.Bytes,
      })

      this.config.logger.info(`Initializing account cache size=${this.config.accountCache}`)
      this.config.logger.info(`Initializing storage cache size=${this.config.storageCache}`)
      this.config.logger.info(`Initializing code cache size=${this.config.codeCache}`)
      this.config.logger.info(`Initializing trie cache size=${this.config.trieCache}`)
      const stateManager = new DefaultStateManager({
        trie,
        prefixStorageTrieKeys: this.config.prefixStorageTrieKeys,
        accountCacheOpts: {
          deactivate: false,
          type: CacheType.LRU,
          size: this.config.accountCache,
        },
        storageCacheOpts: {
          deactivate: false,
          type: CacheType.LRU,
          size: this.config.storageCache,
        },
        codeCacheOpts: {
          deactivate: false,
          type: CacheType.LRU,
          size: this.config.codeCache,
        },
      })

      this.vm = new (VM as any)({
        common: this.config.execCommon,
        blockchain: this.chain.blockchain,
        stateManager,
        profilerOpts: this.config.vmProfilerOpts,
      })
    } else {
      this.vm = this.config.vm
      ;(this.vm as any).blockchain = this.chain.blockchain
    }

    if (this.metaDB && this.config.saveReceipts) {
      this.receiptsManager = new ReceiptsManager({
        chain: this.chain,
        config: this.config,
        metaDB: this.metaDB,
      })
      this.pendingReceipts = new Map()
    }
  }

  /**
   * Run a function after acquiring a lock. It is implied that we have already
   * initialized the module (or we are calling this from the init function, like
   * `_setCanonicalGenesisBlock`)
   * @param action - function to run after acquiring a lock
   * @hidden
   */
  private async runWithLock<T>(action: () => Promise<T>): Promise<T> {
    try {
      await this._lock.acquire()
      const value = await action()
      return value
    } finally {
      this._lock.release()
    }
  }

  /**
   * Initializes VM execution. Must be called before run() is called
   */
  async open(): Promise<void> {
    return this.runWithLock<void>(async () => {
      // if already opened or stopping midway
      if (this.started || this.vmPromise !== undefined) {
        return
      }

      await this.vm.init()
      if (typeof this.vm.blockchain.getIteratorHead !== 'function') {
        throw new Error('cannot get iterator head: blockchain has no getIteratorHead function')
      }
      const headBlock = await this.vm.blockchain.getIteratorHead()
      const { number, timestamp } = headBlock.header
      if (typeof this.vm.blockchain.getTotalDifficulty !== 'function') {
        throw new Error('cannot get iterator head: blockchain has no getTotalDifficulty function')
      }
      const td = await this.vm.blockchain.getTotalDifficulty(headBlock.header.hash())
      this.config.execCommon.setHardforkBy({ blockNumber: number, td, timestamp })
      this.hardfork = this.config.execCommon.hardfork()
      this.config.logger.info(`Initializing VM execution hardfork=${this.hardfork}`)
      if (number === BIGINT_0) {
        const genesisState =
          this.chain['_customGenesisState'] ?? getGenesis(Number(this.vm.common.chainId()))
        if (!genesisState) {
          throw new Error('genesisState not available')
        }
        await this.vm.stateManager.generateCanonicalGenesis(genesisState)
      }
      await super.open()
      // TODO: Should a run be started to execute any left over blocks?
      // void this.run()
    })
  }

  /**
   * Executes the block, runs the necessary verification on it,
   * and persists the block and the associate state into the database.
   * The key difference is it won't do the canonical chain updating.
   * It relies on the additional {@link VMExecution.setHead} call to finalize
   * the entire procedure.
   * @param receipts If we built this block, pass the receipts to not need to run the block again
   * @param optional param if runWithoutSetHead should block for execution
   * @param optional param if runWithoutSetHead should skip putting block into chain
   * @returns if the block was executed or not, throws on block execution failure
   */
  async runWithoutSetHead(
    opts: RunBlockOpts,
    receipts?: TxReceipt[],
    blocking: boolean = false,
    skipBlockchain: boolean = false
  ): Promise<boolean> {
    // if its not blocking request then return early if its already running else wait to grab the lock
    if ((!blocking && this.running) || !this.started || this.config.shutdown) return false

    await this.runWithLock<void>(async () => {
      try {
        // running should be false here because running is always changed inside the lock and switched
        // to false before the lock is released
        this.running = true
        const { block, root } = opts

        if (receipts === undefined) {
          // Check if we need to pass flag to clear statemanager cache or not
          const prevVMStateRoot = await this.vm.stateManager.getStateRoot()
          // If root is not provided its mean to be run on the same set state
          const parentState = root ?? prevVMStateRoot
          const clearCache = !equalsBytes(prevVMStateRoot, parentState)

          const result = await this.vm.runBlock({ clearCache, ...opts })
          receipts = result.receipts
        }
        if (receipts !== undefined) {
          // Save receipts
          this.pendingReceipts?.set(bytesToHex(block.hash()), receipts)
        }

        if (!skipBlockchain) {
          // Bypass updating head by using blockchain db directly
          const [hash, num] = [block.hash(), block.header.number]
          const td =
            (await this.chain.getTd(block.header.parentHash, block.header.number - BIGINT_1)) +
            block.header.difficulty

          await this.chain.blockchain.dbManager.batch([
            DBSetTD(td, num, hash),
            ...DBSetBlockOrHeader(block),
            DBSetHashToNumber(hash, num),
            // Skip the op for number to hash to not alter canonical chain
            ...DBSaveLookups(hash, num, true),
          ])
        }
      } finally {
        this.running = false
      }
    })
    return true
  }

  /**
   * Sets the chain to a new head block.
   * Should only be used after {@link VMExecution.runWithoutSetHead}
   * @param blocks Array of blocks to save pending receipts and set the last block as the head
   */
  async setHead(
    blocks: Block[],
    { finalizedBlock, safeBlock }: { finalizedBlock?: Block; safeBlock?: Block } = {}
  ): Promise<boolean> {
    if (!this.started || this.config.shutdown) return false

    return this.runWithLock<boolean>(async () => {
      const vmHeadBlock = blocks[blocks.length - 1]
      const chainPointers: [string, Block][] = [['vmHeadBlock', vmHeadBlock]]

      // instead of checking for the previous roots of safe,finalized, we will contend
      // ourselves with just vmHead because in snap sync we might not have the safe
      // finalized blocks executed
      if (!(await this.vm.stateManager.hasStateRoot(vmHeadBlock.header.stateRoot))) {
        // If we set blockchain iterator to somewhere where we don't have stateroot
        // execution run will always fail
        throw Error(
          `vmHeadBlock's stateRoot not found number=${vmHeadBlock.header.number} root=${short(
            vmHeadBlock.header.stateRoot
          )}`
        )
      }

      // skip emitting the chain update event as we will manually do it
      await this.chain.putBlocks(blocks, true, true)
      for (const block of blocks) {
        const receipts = this.pendingReceipts?.get(bytesToHex(block.hash()))
        if (receipts) {
          void this.receiptsManager?.saveReceipts(block, receipts)
          this.pendingReceipts?.delete(bytesToHex(block.hash()))
        }
      }

      // check if the head, safe and finalized are now canonical
      for (const [blockName, block] of chainPointers) {
        if (block === null) {
          continue
        }
        const blockByNumber = await this.chain.getBlock(block.header.number)
        if (!equalsBytes(blockByNumber.hash(), block.hash())) {
          throw Error(`${blockName} not in canonical chain`)
        }
      }
      await this.chain.blockchain.setIteratorHead('vm', vmHeadBlock.hash())
      if (safeBlock !== undefined) {
        await this.chain.blockchain.setIteratorHead('safe', safeBlock.hash())
      }
      if (finalizedBlock !== undefined) {
        await this.chain.blockchain.setIteratorHead('finalized', finalizedBlock.hash())
      }
      await this.chain.update(true)
      return true
    })
  }

  /**
   * Runs the VM execution
   * @param loop Whether to continue iterating until vm head equals chain head (default: true)
   * @returns number of blocks executed
   */
  async run(loop = true, runOnlybatched = false): Promise<number> {
    if (this.running || !this.started || this.config.shutdown) return 0

    return this.runWithLock<number>(async () => {
      try {
        // 1. await the run so as to switch this.running to false even in case of errors
        // 2. run inside a lock so as to not be entangle with runWithoutSetHead or setHead
        this.running = true
        let numExecuted: number | null | undefined = undefined

        const { blockchain } = this.vm
        if (typeof blockchain.getIteratorHead !== 'function') {
          throw new Error('cannot get iterator head: blockchain has no getIteratorHead function')
        }
        let startHeadBlock = await blockchain.getIteratorHead()
        if (typeof blockchain.getCanonicalHeadBlock !== 'function') {
          throw new Error(
            'cannot get iterator head: blockchain has no getCanonicalHeadBlock function'
          )
        }
        let canonicalHead = await blockchain.getCanonicalHeadBlock()

        this.config.logger.debug(
          `Running execution startHeadBlock=${startHeadBlock?.header.number} canonicalHead=${canonicalHead?.header.number} loop=${loop}`
        )

        let headBlock: Block | undefined
        let parentState: Uint8Array | undefined
        let errorBlock: Block | undefined

        // flag for vm to clear statemanager cache on runBlock
        //  i) If on start of iterator the last run state is not same as the block's parent
        //  ii) If reorg happens on the block iterator
        let clearCache = false

        while (
          this.started &&
          !this.config.shutdown &&
          (!runOnlybatched ||
            (runOnlybatched &&
              canonicalHead.header.number - startHeadBlock.header.number >=
                BigInt(this.config.numBlocksPerIteration))) &&
          (numExecuted === undefined ||
            (loop && numExecuted === this.config.numBlocksPerIteration)) &&
          equalsBytes(startHeadBlock.hash(), canonicalHead.hash()) === false
        ) {
          let txCounter = 0
          headBlock = undefined
          parentState = undefined
          errorBlock = undefined
          this.vmPromise = blockchain
            .iterator(
              'vm',
              async (block: Block, reorg: boolean) => {
                // determine starting state for block run
                // if we are just starting or if a chain reorg has happened
                if (headBlock === undefined || reorg) {
                  headBlock = await blockchain.getBlock(block.header.parentHash)
                  parentState = headBlock.header.stateRoot

                  if (reorg) {
                    clearCache = true
                    this.config.logger.info(
                      `VM run: Chain reorged, setting new head to block number=${headBlock.header.number} clearCache=${clearCache}.`
                    )
                  } else {
                    const prevVMStateRoot = await this.vm.stateManager.getStateRoot()
                    clearCache = !equalsBytes(prevVMStateRoot, parentState)
                  }
                } else {
                  // Continuation of last vm run, no need to clearCache
                  clearCache = false
                }

                // run block, update head if valid
                try {
                  const { number, timestamp } = block.header
                  if (typeof blockchain.getTotalDifficulty !== 'function') {
                    throw new Error(
                      'cannot get iterator head: blockchain has no getTotalDifficulty function'
                    )
                  }
                  const td = await blockchain.getTotalDifficulty(block.header.parentHash)

                  const hardfork = this.config.execCommon.getHardforkBy({
                    blockNumber: number,
                    td,
                    timestamp,
                  })
                  if (hardfork !== this.hardfork) {
                    const hash = short(block.hash())
                    this.config.superMsg(
                      `Execution hardfork switch on block number=${number} hash=${hash} old=${this.hardfork} new=${hardfork}`
                    )
                    this.hardfork = this.config.execCommon.setHardforkBy({
                      blockNumber: number,
                      td,
                      timestamp,
                    })
                  }
                  let skipBlockValidation = false
                  if (this.config.execCommon.consensusType() === ConsensusType.ProofOfAuthority) {
                    // Block validation is redundant here and leads to consistency problems
                    // on PoA clique along blockchain-including validation checks
                    // (signer states might have moved on when sync is ahead)
                    skipBlockValidation = true
                  }

                  // we are skipping header validation because the block has been picked from the
                  // blockchain and header should have already been validated while putBlock
                  if (!this.started) {
                    throw Error('Execution stopped')
                  }

                  this._statsVm = this.vm
                  const beforeTS = Date.now()
                  const result = await this.vm.runBlock({
                    block,
                    root: parentState,
                    clearCache,
                    skipBlockValidation,
                    skipHeaderValidation: true,
                  })
                  const afterTS = Date.now()
                  const diffSec = Math.round((afterTS - beforeTS) / 1000)

                  if (diffSec > this.MAX_TOLERATED_BLOCK_TIME) {
                    const msg = `Slow block execution for block num=${
                      block.header.number
                    } hash=${bytesToHex(block.hash())} txs=${block.transactions.length} gasUsed=${
                      result.gasUsed
                    } time=${diffSec}secs`
                    this.config.logger.warn(msg)
                  }

                  void this.receiptsManager?.saveReceipts(block, result.receipts)

                  txCounter += block.transactions.length
                  // set as new head block
                  headBlock = block
                  parentState = block.header.stateRoot
                } catch (error: any) {
                  // Store error block and throw which will make iterator stop, exit and save
                  // last successfully executed head as vmHead
                  errorBlock = block
                  throw error
                }
              },
              this.config.numBlocksPerIteration,
              // release lock on this callback so other blockchain ops can happen while this block is being executed
              true
            )
            // Ensure to catch and not throw as this would lead to unCaughtException with process exit
            .catch(async (error) => {
              if (errorBlock !== undefined) {
                // TODO: determine if there is a way to differentiate between the cases
                // a) a bad block is served by a bad peer -> delete the block and restart sync
                //    sync from parent block
                // b) there is a consensus error in the VM -> stop execution until the
                //    consensus error is fixed
                //
                // For now only option b) is implemented, atm this is a very likely case
                // and the implemented behavior helps on debugging.
                // Option a) would likely need some block comparison of the same blocks
                // received by different peer to decide on bad blocks
                // (minimal solution: receive block from 3 peers and take block if there is
                // is equally served from at least 2 peers)
                /*try {
            // remove invalid block
              await blockchain!.delBlock(block.header.hash())
            } catch (error: any) {
              this.config.logger.error(
                `Error deleting block number=${blockNumber} hash=${hash} on failed execution`
              )
            }
            this.config.logger.warn(
              `Deleted block number=${blockNumber} hash=${hash} on failed execution`
            )

            const hardfork = this.config.execCommon.getHardforkBy({ blockNumber })
            if (hardfork !== this.hardfork) {
              this.config.logger.warn(
                `Set back hardfork along block deletion number=${blockNumber} hash=${hash} old=${this.hardfork} new=${hardfork}`
              )
              this.config.execCommon.setHardforkBy({ blockNumber, td })
            }*/
                // Option a): set iterator head to the parent block so that an
                // error can repeatedly processed for debugging
                const { number } = errorBlock.header
                const hash = short(errorBlock.hash())
                const errorMsg = `Execution of block number=${number} hash=${hash} hardfork=${this.hardfork} failed`

                // check if the vmHead 's backstepping can resolve this issue, headBlock is parent of the
                // current block which is trying to be executed and should equal current vmHead
                if (
                  `${error}`.toLowerCase().includes('does not contain state root') &&
                  number > BIGINT_1
                ) {
                  // this is a weird case which has been observed, could be because of a forking scenario
                  // or some race condition, but if this happens for now we can try to handle it by
                  // backstepping to the parent. if the parent isn't there, it can recursively go back
                  // to parent's parent and so on...
                  //
                  // There can also be a better way to backstep vm to but lets naively step back
                  let backStepTo,
                    backStepToHash,
                    backStepToRoot,
                    hasParentStateRoot = false
                  if (headBlock !== undefined) {
                    hasParentStateRoot = await this.vm.stateManager.hasStateRoot(
                      headBlock.header.stateRoot
                    )
                    backStepTo = headBlock.header.number ?? BIGINT_0 - BIGINT_1
                    backStepToHash = headBlock.header.parentHash
                    backStepToRoot = headBlock.header.stateRoot
                  }

                  if (hasParentStateRoot === true && backStepToHash !== undefined) {
                    this.config.logger.warn(
                      `${errorMsg}, backStepping vmHead to number=${backStepTo} hash=${short(
                        backStepToHash ?? 'na'
                      )} hasParentStateRoot=${short(backStepToRoot ?? 'na')}:\n${error}`
                    )
                    await this.vm.blockchain.setIteratorHead('vm', backStepToHash)
                  } else {
                    this.config.logger.error(
                      `${errorMsg}, couldn't back step to vmHead number=${backStepTo} hash=${short(
                        backStepToHash ?? 'na'
                      )} hasParentStateRoot=${hasParentStateRoot} backStepToRoot=${short(
                        backStepToRoot ?? 'na'
                      )}:\n${error}`
                    )
                  }
                } else {
                  this.config.logger.warn(`${errorMsg}:\n${error}`)
                }

                if (this.config.debugCode) {
                  await debugCodeReplayBlock(this, errorBlock)
                }
                this.config.events.emit(Event.SYNC_EXECUTION_VM_ERROR, error)
                const actualExecuted = Number(
                  errorBlock.header.number - startHeadBlock.header.number
                )
                return actualExecuted
              } else {
                this.config.logger.error(`VM execution failed with error`, error)
                return null
              }
            })

          numExecuted = await this.vmPromise
          if (numExecuted !== null) {
            let endHeadBlock
            if (typeof this.vm.blockchain.getIteratorHead === 'function') {
              endHeadBlock = await this.vm.blockchain.getIteratorHead('vm')
            } else {
              throw new Error(
                'cannot get iterator head: blockchain has no getIteratorHead function'
              )
            }

            if (typeof numExecuted === 'number' && numExecuted > 0) {
              const firstNumber = startHeadBlock.header.number
              const firstHash = short(startHeadBlock.hash())
              const lastNumber = endHeadBlock.header.number
              const lastHash = short(endHeadBlock.hash())
              const baseFeeAdd =
                this.config.execCommon.gteHardfork(Hardfork.London) === true
                  ? `baseFee=${endHeadBlock.header.baseFeePerGas} `
                  : ''

              const tdAdd =
                this.config.execCommon.gteHardfork(Hardfork.Paris) === true
                  ? ''
                  : `td=${this.chain.blocks.td} `
              ;(this.config.execCommon.gteHardfork(Hardfork.Paris) === true
                ? this.config.logger.debug
                : this.config.logger.info)(
                `Executed blocks count=${numExecuted} first=${firstNumber} hash=${firstHash} ${tdAdd}${baseFeeAdd}hardfork=${this.hardfork} last=${lastNumber} hash=${lastHash} txs=${txCounter}`
              )
            } else {
              this.config.logger.debug(
                `No blocks executed past chain head hash=${short(endHeadBlock.hash())} number=${
                  endHeadBlock.header.number
                }`
              )
            }
            startHeadBlock = endHeadBlock
            if (typeof this.vm.blockchain.getCanonicalHeadBlock !== 'function') {
              throw new Error(
                'cannot get iterator head: blockchain has no getCanonicalHeadBlock function'
              )
            }
            canonicalHead = await this.vm.blockchain.getCanonicalHeadBlock()
          }
        }

        return numExecuted ?? 0
      } finally {
        this.running = false
      }
    })
  }

  /**
   * Start execution
   */
  async start(): Promise<boolean> {
    this._statsInterval = setInterval(
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await this.stats.bind(this),
      this.STATS_INTERVAL
    )

    const { blockchain } = this.vm
    if (this.running || !this.started) {
      return false
    }

    if (typeof blockchain.getIteratorHead !== 'function') {
      throw new Error('cannot get iterator head: blockchain has no getIteratorHead function')
    }
    const vmHeadBlock = await blockchain.getIteratorHead()
    if (typeof blockchain.getCanonicalHeadBlock !== 'function') {
      throw new Error('cannot get iterator head: blockchain has no getCanonicalHeadBlock function')
    }
    const canonicalHead = await blockchain.getCanonicalHeadBlock()

    const infoStr = `vmHead=${vmHeadBlock.header.number} canonicalHead=${
      canonicalHead.header.number
    } hardfork=${this.config.execCommon.hardfork()} execution=${this.config.execution}`
    if (
      !this.config.execCommon.gteHardfork(Hardfork.Paris) &&
      this.config.execution &&
      vmHeadBlock.header.number < canonicalHead.header.number
    ) {
      this.config.logger.info(`Starting execution run ${infoStr}`)
      void this.run(true, true)
    } else {
      this.config.logger.info(`Skipped execution run ${infoStr}`)
    }
    return true
  }

  /**
   * Stop VM execution. Returns a promise that resolves once its stopped.
   */
  async stop(): Promise<boolean> {
    clearInterval(this._statsInterval)
    // Stop with the lock to be concurrency safe and flip started flag so that
    // vmPromise can resolve early
    await this.runWithLock<void>(async () => {
      await super.stop()
    })
    // Resolve this promise outside lock since promise also acquires the lock while
    // running the iterator
    if (this.vmPromise) {
      // ensure that we wait that the VM finishes executing the block (and flushing the trie cache)
      await this.vmPromise
    }
    // Since we don't allow open unless vmPromise is undefined, no opens can happen
    // midway and we can safely close
    await this.runWithLock<void>(async () => {
      this.vmPromise = undefined
      await this.stateDB?.close()
    })
    return true
  }

  /**
   * Execute a range of blocks on a copy of the VM
   * without changing any chain or client state
   *
   * Possible input formats:
   *
   * - Single block, '5'
   * - Range of blocks, '5-10'
   */
  async executeBlocks(first: number, last: number, txHashes: string[]) {
    this.config.logger.info('Preparing for block execution (debug mode, no services started)...')
    const vm = await this.vm.shallowCopy(false)

    for (let blockNumber = first; blockNumber <= last; blockNumber++) {
      const block = await vm.blockchain.getBlock(blockNumber)
      const parentBlock = await vm.blockchain.getBlock(block.header.parentHash)
      // Set the correct state root
      const root = parentBlock.header.stateRoot
      if (typeof vm.blockchain.getTotalDifficulty !== 'function') {
        throw new Error('cannot get iterator head: blockchain has no getTotalDifficulty function')
      }
      const td = await vm.blockchain.getTotalDifficulty(block.header.parentHash)
      vm.common.setHardforkBy({
        blockNumber,
        td,
        timestamp: block.header.timestamp,
      })

      if (txHashes.length === 0) {
        this._statsVm = vm

        // we are skipping header validation because the block has been picked from the
        // blockchain and header should have already been validated while putBlock
        const beforeTS = Date.now()
        const res = await vm.runBlock({
          block,
          root,
          clearCache: false,
          skipHeaderValidation: true,
        })
        const afterTS = Date.now()
        const diffSec = Math.round((afterTS - beforeTS) / 1000)
        const msg = `Executed block num=${blockNumber} hash=${bytesToHex(block.hash())} txs=${
          block.transactions.length
        } gasUsed=${res.gasUsed} time=${diffSec}secs`
        if (diffSec <= this.MAX_TOLERATED_BLOCK_TIME) {
          this.config.logger.info(msg)
        } else {
          this.config.logger.warn(msg)
        }
      } else {
        let count = 0
        // Special verbose tx execution mode triggered by BLOCK_NUMBER[*]
        // Useful e.g. to trace slow txs
        const allTxs = txHashes.length === 1 && txHashes[0] === '*' ? true : false
        for (const tx of block.transactions) {
          const txHash = bytesToHex(tx.hash())
          if (allTxs || txHashes.includes(txHash)) {
            const res = await vm.runTx({ block, tx })
            this.config.logger.info(
              `Executed tx hash=${txHash} gasUsed=${res.totalGasSpent} from block num=${blockNumber}`
            )
            count += 1
          }
        }
        if (count === 0) {
          if (!allTxs) {
            this.config.logger.warn(`Block number ${first} contains no txs with provided hashes`)
          } else {
            this.config.logger.info(`Block has 0 transactions (no execution)`)
          }
        }
      }
    }
  }

  stats() {
    if (this._statsVm !== undefined) {
      const sm = this._statsVm.stateManager as any
      const disactivatedStats = { size: 0, reads: 0, hits: 0, writes: 0 }
      let stats
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
      stats = !sm._accountCacheSettings.deactivate ? sm._accountCache.stats() : disactivatedStats
      this.config.logger.info(
        `Account cache stats size=${stats.size} reads=${stats.reads} hits=${stats.hits} writes=${stats.writes}`
      )
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
      stats = !sm._storageCacheSettings.deactivate ? sm._storageCache.stats() : disactivatedStats
      this.config.logger.info(
        `Storage cache stats size=${stats.size} reads=${stats.reads} hits=${stats.hits} writes=${stats.writes}`
      )
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
      stats = !sm._codeCacheSettings.deactivate ? sm._codeCache.stats() : disactivatedStats
      this.config.logger.info(
        `Code cache stats size=${stats.size} reads=${stats.reads} hits=${stats.hits} writes=${stats.writes}`
      )
      const tStats = (sm._trie as Trie).database().stats()
      this.config.logger.info(
        `Trie cache stats size=${tStats.size} reads=${tStats.cache.reads} hits=${tStats.cache.hits} ` +
          `writes=${tStats.cache.writes} readsDB=${tStats.db.reads} hitsDB=${tStats.db.hits} writesDB=${tStats.db.writes}`
      )
    }
  }
}
