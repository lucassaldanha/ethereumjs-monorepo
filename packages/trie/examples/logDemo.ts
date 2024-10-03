/**
 * Run with DEBUG=ethjs,trie:* to see debug log output
 */
import { MerklePatriciaTrie, createMerkleProof, verifyMerkleProof } from '@ethereumjs/trie'
import { utf8ToBytes } from '@ethereumjs/util'

const trie_entries: [string, string | null][] = [
  ['do', 'verb'],
  ['ether', 'wookiedoo'], // cspell:disable-line
  ['horse', 'stallion'],
  ['shaman', 'horse'],
  ['doge', 'coin'],
  ['ether', null],
  ['dog', 'puppy'],
  ['shaman', null],
]

const main = async () => {
  const trie = new MerklePatriciaTrie({
    useRootPersistence: true,
  })
  for (const [key, value] of trie_entries) {
    await trie.put(utf8ToBytes(key), value === null ? Uint8Array.from([]) : utf8ToBytes(value))
  }
  const proof = await createMerkleProof(trie, utf8ToBytes('doge'))
  const valid = await verifyMerkleProof(trie, trie.root(), utf8ToBytes('doge'), proof)
  console.log('valid', valid)
}

void main()
