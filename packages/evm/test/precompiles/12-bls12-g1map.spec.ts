import { Chain, Common, Hardfork } from '@ethereumjs/common'
import { bytesToHex, hexToBytes } from '@ethereumjs/util'
import { assert, describe, it } from 'vitest'

import { EVM, getActivePrecompiles } from '../../src/index.js'

// Taken from https://github.com/ethereum/EIPs/blob/master/assets/eip-2537/map_fp_to_G1_bls.json
const testData = [
  {
    Input:
      '00000000000000000000000000000000156c8a6a2c184569d69a76be144b5cdc5141d2d2ca4fe341f011e25e3969c55ad9e9b9ce2eb833c81a908e5fa4ac5f03',
    Name: 'bls_g1map_',
    Expected:
      '00000000000000000000000000000000184bb665c37ff561a89ec2122dd343f20e0f4cbcaec84e3c3052ea81d1834e192c426074b02ed3dca4e7676ce4ce48ba0000000000000000000000000000000004407b8d35af4dacc809927071fc0405218f1401a6d15af775810e4e460064bcc9468beeba82fdc751be70476c888bf3',
    Gas: 5500,
    NoBenchmark: false,
  },
  {
    Input:
      '00000000000000000000000000000000147e1ed29f06e4c5079b9d14fc89d2820d32419b990c1c7bb7dbea2a36a045124b31ffbde7c99329c05c559af1c6cc82',
    Name: 'bls_g1map_616263',
    Expected:
      '00000000000000000000000000000000009769f3ab59bfd551d53a5f846b9984c59b97d6842b20a2c565baa167945e3d026a3755b6345df8ec7e6acb6868ae6d000000000000000000000000000000001532c00cf61aa3d0ce3e5aa20c3b531a2abd2c770a790a2613818303c6b830ffc0ecf6c357af3317b9575c567f11cd2c',
    Gas: 5500,
    NoBenchmark: false,
  },
  {
    Input:
      '0000000000000000000000000000000004090815ad598a06897dd89bcda860f25837d54e897298ce31e6947378134d3761dc59a572154963e8c954919ecfa82d',
    Name: 'bls_g1map_6162636465663031',
    Expected:
      '000000000000000000000000000000001974dbb8e6b5d20b84df7e625e2fbfecb2cdb5f77d5eae5fb2955e5ce7313cae8364bc2fff520a6c25619739c6bdcb6a0000000000000000000000000000000015f9897e11c6441eaa676de141c8d83c37aab8667173cbe1dfd6de74d11861b961dccebcd9d289ac633455dfcc7013a3',
    Gas: 5500,
    NoBenchmark: false,
  },
  {
    Input:
      '0000000000000000000000000000000008dccd088ca55b8bfbc96fb50bb25c592faa867a8bb78d4e94a8cc2c92306190244532e91feba2b7fed977e3c3bb5a1f',
    Name: 'bls_g1map_713132385f717171',
    Expected:
      '000000000000000000000000000000000a7a047c4a8397b3446450642c2ac64d7239b61872c9ae7a59707a8f4f950f101e766afe58223b3bff3a19a7f754027c000000000000000000000000000000001383aebba1e4327ccff7cf9912bda0dbc77de048b71ef8c8a81111d71dc33c5e3aa6edee9cf6f5fe525d50cc50b77cc9',
    Gas: 5500,
    NoBenchmark: false,
  },
  {
    Input:
      '000000000000000000000000000000000dd824886d2123a96447f6c56e3a3fa992fbfefdba17b6673f9f630ff19e4d326529db37e1c1be43f905bf9202e0278d',
    Name: 'bls_g1map_613531325f616161',
    Expected:
      '000000000000000000000000000000000e7a16a975904f131682edbb03d9560d3e48214c9986bd50417a77108d13dc957500edf96462a3d01e62dc6cd468ef11000000000000000000000000000000000ae89e677711d05c30a48d6d75e76ca9fb70fe06c6dd6ff988683d89ccde29ac7d46c53bb97a59b1901abf1db66052db',
    Gas: 5500,
    NoBenchmark: false,
  },
]
describe('Precompiles: BLS12-FP-TO-G1', () => {
  it('should produce expected output', async () => {
    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Berlin, eips: [2537] })
    const evm = await EVM.create({
      common,
    })
    const BLS12FPTOG1 = getActivePrecompiles(common).get(
      '0000000000000000000000000000000000000012'
    )!

    for (const testVector of testData) {
      const result = await BLS12FPTOG1({
        data: hexToBytes(`0x${testVector.Input}`),
        gasLimit: BigInt(5000000),
        common,
        _EVM: evm,
      })

      assert.deepEqual(
        '0x' + testVector.Expected,
        bytesToHex(result.returnValue),
        'return value should match testVectorResult'
      )
      assert.equal(result.executionGasUsed, BigInt(testVector.Gas))
    }
  })
})
