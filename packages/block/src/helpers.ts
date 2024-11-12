import { MerklePatriciaTrie } from "@ethereumjs/mpt";
import { RLP } from "@ethereumjs/rlp";
import { Blob4844Tx } from "@ethereumjs/tx";
import {
  BIGINT_0,
  BIGINT_1,
  TypeOutput,
  isHexString,
  toType,
} from "@ethereumjs/util";
import { concatBytes } from "ethereum-cryptography/utils";

import type { TypedTransaction } from "@ethereumjs/tx";
import type {
  CLRequest,
  CLRequestType,
  PrefixedHexString,
  Withdrawal,
} from "@ethereumjs/util";
import type { BlockHeaderBytes, HeaderData } from "./types.js";

/**
 * Returns a 0x-prefixed hex number string from a hex string or string integer.
 * @param {string} input string to check, convert, and return
 */
export const numberToHex = (input?: string): PrefixedHexString | undefined => {
  if (input === undefined) return undefined;
  if (!isHexString(input)) {
    const regex = new RegExp(/^\d+$/); // test to make sure input contains only digits
    if (!regex.test(input)) {
      const msg = `Cannot convert string to hex string. numberToHex only supports 0x-prefixed hex or integer strings but the given string was: ${input}`;
      throw new Error(msg);
    }
    return `0x${Number.parseInt(input, 10).toString(16)}`;
  }
  return input;
};

export function valuesArrayToHeaderData(values: BlockHeaderBytes): HeaderData {
  const [
    parentHash,
    uncleHash,
    coinbase,
    stateRoot,
    transactionsTrie,
    receiptTrie,
    logsBloom,
    difficulty,
    number,
    gasLimit,
    gasUsed,
    timestamp,
    extraData,
    mixHash,
    nonce,
    baseFeePerGas,
    withdrawalsRoot,
    blobGasUsed,
    excessBlobGas,
    parentBeaconBlockRoot,
    requestsHash,
  ] = values;

  if (values.length > 21) {
    throw new Error(
      `invalid header. More values than expected were received. Max: 20, got: ${values.length}`,
    );
  }
  if (values.length < 15) {
    throw new Error(
      `invalid header. Less values than expected were received. Min: 15, got: ${values.length}`,
    );
  }

  return {
    parentHash,
    uncleHash,
    coinbase,
    stateRoot,
    transactionsTrie,
    receiptTrie,
    logsBloom,
    difficulty,
    number,
    gasLimit,
    gasUsed,
    timestamp,
    extraData,
    mixHash,
    nonce,
    baseFeePerGas,
    withdrawalsRoot,
    blobGasUsed,
    excessBlobGas,
    parentBeaconBlockRoot,
    requestsHash,
  };
}

export function getDifficulty(headerData: HeaderData): bigint | null {
  const { difficulty } = headerData;
  if (difficulty !== undefined) {
    return toType(difficulty, TypeOutput.BigInt);
  }
  return null;
}

export const getNumBlobs = (transactions: TypedTransaction[]) => {
  let numBlobs = 0;
  for (const tx of transactions) {
    if (tx instanceof Blob4844Tx) {
      numBlobs += tx.blobVersionedHashes.length;
    }
  }
  return numBlobs;
};

/**
 * Approximates `factor * e ** (numerator / denominator)` using Taylor expansion
 */
export const fakeExponential = (
  factor: bigint,
  numerator: bigint,
  denominator: bigint,
) => {
  let i = BIGINT_1;
  let output = BIGINT_0;
  let numeratorAccumulator = factor * denominator;
  while (numeratorAccumulator > BIGINT_0) {
    output += numeratorAccumulator;
    numeratorAccumulator =
      (numeratorAccumulator * numerator) / (denominator * i);
    i++;
  }

  return output / denominator;
};

/**
 * Returns the withdrawals trie root for array of Withdrawal.
 * @param wts array of Withdrawal to compute the root of
 * @param optional emptyTrie to use to generate the root
 */
export async function genWithdrawalsTrieRoot(
  wts: Withdrawal[],
  emptyTrie?: MerklePatriciaTrie,
) {
  const trie = emptyTrie ?? new MerklePatriciaTrie();
  for (const [i, wt] of wts.entries()) {
    await trie.put(RLP.encode(i), RLP.encode(wt.raw()));
  }
  return trie.root();
}

/**
 * Returns the txs trie root for array of TypedTransaction
 * @param txs array of TypedTransaction to compute the root of
 * @param optional emptyTrie to use to generate the root
 */
export async function genTransactionsTrieRoot(
  txs: TypedTransaction[],
  emptyTrie?: MerklePatriciaTrie,
) {
  const trie = emptyTrie ?? new MerklePatriciaTrie();
  for (const [i, tx] of txs.entries()) {
    await trie.put(RLP.encode(i), tx.serialize());
  }
  return trie.root();
}

/**
 * Returns the requests trie root for an array of CLRequests
 * @param requests - an array of CLRequests
 * @param emptyTrie optional empty trie used to generate the root
 * @returns a 32 byte Uint8Array representing the requests trie root
 */
export function genRequestsRoot(
  requests: CLRequest<CLRequestType>[],
  sha256Function: (msg: Uint8Array) => Uint8Array,
) {
  // Requests should be sorted in monotonically ascending order based on type
  // and whatever internal sorting logic is defined by each request type
  if (requests.length > 1) {
    for (let x = 1; x < requests.length; x++) {
      if (requests[x].type < requests[x - 1].type)
        throw new Error("requests are not sorted in ascending order");
    }
  }

  // def compute_requests_hash(list):
  //    return keccak256(rlp.encode([rlp.encode(req) for req in list]))

  let flatRequests = new Uint8Array();
  for (const req of requests) {
    flatRequests = concatBytes(flatRequests, sha256Function(req.bytes));
  }

  return sha256Function(flatRequests);
}
