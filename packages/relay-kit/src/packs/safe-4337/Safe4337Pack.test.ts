import crypto from 'crypto'
import dotenv from 'dotenv'
import * as viem from 'viem'
import Safe, * as protocolKit from '@safe-global/protocol-kit'
import { WebAuthnCredentials, createMockPasskey } from '@safe-global/protocol-kit/test-utils'
import {
  getSafeModuleSetupDeployment,
  getSafe4337ModuleDeployment
} from '@safe-global/safe-modules-deployments'
import { MetaTransactionData, OperationType } from '@safe-global/types-kit'
import { Safe4337Pack } from './Safe4337Pack'
import BaseSafeOperation from './BaseSafeOperation'
import * as constants from './constants'
import * as utils from './utils'
import {
  fixtures,
  createSafe4337Pack,
  generateTransferCallData
} from '@safe-global/relay-kit/test-utils'

dotenv.config()

const requestResponseMap = {
  [constants.RPC_4337_CALLS.SUPPORTED_ENTRY_POINTS]: [
    fixtures.ENTRYPOINT_ADDRESS_V06,
    fixtures.ENTRYPOINT_ADDRESS_V07
  ],
  [constants.RPC_4337_CALLS.CHAIN_ID]: fixtures.CHAIN_ID,
  [constants.RPC_4337_CALLS.SEND_USER_OPERATION]: fixtures.USER_OPERATION_HASH,
  [constants.RPC_4337_CALLS.ESTIMATE_USER_OPERATION_GAS]: fixtures.GAS_ESTIMATION,
  [constants.RPC_4337_CALLS.GET_USER_OPERATION_BY_HASH]: fixtures.USER_OPERATION_BY_HASH,
  [constants.RPC_4337_CALLS.GET_USER_OPERATION_RECEIPT]: fixtures.USER_OPERATION_RECEIPT,
  ['pimlico_getUserOperationGasPrice']: fixtures.USER_OPERATION_GAS_PRICE
}

const requestMock = jest.fn(async ({ method }: { method: keyof typeof requestResponseMap }) => {
  return requestResponseMap[method]
})

jest.mock('./utils', () => ({
  ...jest.requireActual('./utils'),
  createBundlerClient: jest.fn(() => ({ request: requestMock }))
}))

let safe4337ModuleAddress: viem.Hash
let safeModulesSetupAddress: string

describe('Safe4337Pack', () => {
  beforeAll(async () => {
    const network = parseInt(fixtures.CHAIN_ID).toString()
    safe4337ModuleAddress = getSafe4337ModuleDeployment({
      released: true,
      version: '0.3.0',
      network
    })?.networkAddresses[network] as viem.Hash
    safeModulesSetupAddress = getSafeModuleSetupDeployment({
      released: true,
      version: '0.3.0',
      network
    })?.networkAddresses[network] as string
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('4337 Safe validation', () => {
    it('should throw an error if the Safe version is not greater than 1.4.1', async () => {
      await expect(
        createSafe4337Pack({ options: { safeAddress: fixtures.SAFE_ADDRESS_v1_3_0 } })
      ).rejects.toThrow(
        'Incompatibility detected: The current Safe Account version (1.3.0) is not supported. EIP-4337 requires the Safe to use at least v1.4.1.'
      )
    })

    it('should throw an error if the 4337 Module is not enabled in the Safe account', async () => {
      await expect(
        createSafe4337Pack({
          options: { safeAddress: fixtures.SAFE_ADDRESS_4337_MODULE_NOT_ENABLED }
        })
      ).rejects.toThrow(
        `Incompatibility detected: The EIP-4337 module is not enabled in the provided Safe Account. Enable this module (address: ${fixtures.SAFE_4337_MODULE_ADDRESS_V0_2_0}) to add compatibility.`
      )
    })

    it('should throw an error if the 4337 fallbackhandler is not attached to the Safe account', async () => {
      await expect(
        createSafe4337Pack({
          options: { safeAddress: fixtures.SAFE_ADDRESS_4337_FALLBACKHANDLER_NOT_ENABLED }
        })
      ).rejects.toThrow(
        `Incompatibility detected: The EIP-4337 fallbackhandler is not attached to the Safe Account. Attach this fallbackhandler (address: ${fixtures.SAFE_4337_MODULE_ADDRESS_V0_2_0}) to ensure compatibility.`
      )
    })

    it('should throw an error if the Safe Modules do not match the supported version', async () => {
      await expect(
        createSafe4337Pack({
          options: { safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE },
          safeModulesVersion: '9.9.9'
        })
      ).rejects.toThrow(
        'Safe4337Module and/or SafeModuleSetup not available for chain 11155111 and modules version 9.9.9'
      )
    })
  })

  describe('When using existing Safe Accounts with version 1.4.1 or greater', () => {
    it('should throw an error if the version of the entrypoint used is incompatible', async () => {
      await expect(
        createSafe4337Pack({
          options: { safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE },
          customContracts: { entryPointAddress: fixtures.ENTRYPOINT_ADDRESS_V06 },
          safeModulesVersion: '0.3.0'
        })
      ).rejects.toThrow(
        `The selected entrypoint ${fixtures.ENTRYPOINT_ADDRESS_V06} is not compatible with version 0.3.0 of Safe modules`
      )
    })

    it('should throw an error if no supported entrypoints are available', async () => {
      const overridenMap = Object.assign({}, requestResponseMap, {
        [constants.RPC_4337_CALLS.SUPPORTED_ENTRY_POINTS]: [fixtures.ENTRYPOINT_ADDRESS_V06]
      })

      const mockedUtils = jest.requireMock('./utils')
      mockedUtils.createBundlerClient.mockImplementationOnce(() => ({
        request: jest.fn(
          async ({ method }: { method: keyof typeof overridenMap }) => overridenMap[method]
        )
      }))

      await expect(
        createSafe4337Pack({
          options: { safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE },
          safeModulesVersion: '0.3.0'
        })
      ).rejects.toThrow(
        `Incompatibility detected: None of the entrypoints provided by the bundler is compatible with the Safe modules version 0.3.0`
      )
    })

    it('should be able to instantiate the pack using a existing Safe', async () => {
      const safe4337Pack = await createSafe4337Pack({
        options: { safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE },
        safeModulesVersion: '0.3.0'
      })

      expect(safe4337Pack).toBeInstanceOf(Safe4337Pack)
      expect(safe4337Pack.protocolKit).toBeInstanceOf(Safe)
      expect(await safe4337Pack.protocolKit.getAddress()).toBe(
        fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE
      )
      expect(await safe4337Pack.getChainId()).toBe(fixtures.CHAIN_ID)
    })

    it('should have the 4337 module enabled', async () => {
      const safe4337Pack = await createSafe4337Pack({
        options: { safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE },
        safeModulesVersion: '0.3.0'
      })

      expect(await safe4337Pack.protocolKit.getModules()).toContain(safe4337ModuleAddress)
    })

    it('should detect if a custom 4337 module is not enabled in the Safe', async () => {
      await expect(
        createSafe4337Pack({
          customContracts: {
            safe4337ModuleAddress: '0xCustomModule'
          },
          options: {
            safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE
          },
          safeModulesVersion: '0.3.0'
        })
      ).rejects.toThrow(
        'Incompatibility detected: The EIP-4337 module is not enabled in the provided Safe Account. Enable this module (address: 0xCustomModule) to add compatibility.'
      )
    })

    it('should use the 4337 module as the fallback handler', async () => {
      const safe4337Pack = await createSafe4337Pack({
        options: {
          safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE
        },
        safeModulesVersion: '0.3.0'
      })

      expect(await safe4337Pack.protocolKit.getFallbackHandler()).toEqual(safe4337ModuleAddress)
    })
  })

  describe('When the Safe Account does not exists', () => {
    it('should be able to instantiate the pack using a predicted Safe', async () => {
      const safe4337Pack = await createSafe4337Pack({
        options: {
          owners: [fixtures.OWNER_1],
          threshold: 1
        },
        safeModulesVersion: '0.3.0'
      })

      expect(await safe4337Pack.protocolKit.getAddress()).toBe(fixtures.PREDICTED_SAFE_ADDRESS)
    })

    it('should throw an error if the entrypoint is not compatible with the safe modules version', async () => {
      await expect(
        createSafe4337Pack({
          options: {
            owners: [fixtures.OWNER_1],
            threshold: 1
          },
          customContracts: { entryPointAddress: fixtures.ENTRYPOINT_ADDRESS_V06 },
          safeModulesVersion: '0.3.0'
        })
      ).rejects.toThrow(
        `The selected entrypoint ${fixtures.ENTRYPOINT_ADDRESS_V06} is not compatible with version 0.3.0 of Safe modules`
      )
    })

    it('should throw an error if the owners or threshold are not specified', async () => {
      await expect(
        createSafe4337Pack({
          // @ts-expect-error - An error will be thrown
          options: {
            threshold: 1
          }
        })
      ).rejects.toThrow('Owners and threshold are required to deploy a new Safe')

      await expect(
        createSafe4337Pack({
          // @ts-expect-error - An error will be thrown
          options: {
            owners: [fixtures.OWNER_1]
          }
        })
      ).rejects.toThrow('Owners and threshold are required to deploy a new Safe')
    })

    it('should encode the enableModules transaction as deployment data', async () => {
      const encodeFunctionDataSpy = jest.spyOn(viem, 'encodeFunctionData')
      const safeCreateSpy = jest.spyOn(Safe, 'init')

      const safe4337Pack = await createSafe4337Pack({
        options: {
          owners: [fixtures.OWNER_1, fixtures.OWNER_2],
          threshold: 1
        },
        safeModulesVersion: '0.3.0'
      })

      expect(encodeFunctionDataSpy).toHaveBeenCalledWith({
        abi: constants.ABI,
        functionName: 'enableModules',
        args: [[safe4337ModuleAddress]]
      })
      expect(safeCreateSpy).toHaveBeenCalledWith({
        provider: safe4337Pack.protocolKit.getSafeProvider().provider,
        signer: safe4337Pack.protocolKit.getSafeProvider().signer,
        predictedSafe: {
          safeDeploymentConfig: {
            safeVersion: constants.DEFAULT_SAFE_VERSION,
            saltNonce: undefined
          },
          safeAccountConfig: {
            owners: [fixtures.OWNER_1, fixtures.OWNER_2],
            threshold: 1,
            to: safeModulesSetupAddress,
            data: viem.encodeFunctionData({
              abi: constants.ABI,
              functionName: 'enableModules',
              args: [[safe4337ModuleAddress]]
            }),
            fallbackHandler: safe4337ModuleAddress,
            paymentToken: viem.zeroAddress,
            payment: 0,
            paymentReceiver: viem.zeroAddress
          }
        }
      })
    })

    it('should encode the enablesModule transaction together with a specific token approval in a multiSend call when trying to use a paymaster', async () => {
      const encodeFunctionDataSpy = jest.spyOn(viem, 'encodeFunctionData')
      const safeCreateSpy = jest.spyOn(Safe, 'init')

      const safe4337Pack = await createSafe4337Pack({
        options: {
          owners: [fixtures.OWNER_1],
          threshold: 1
        },
        safeModulesVersion: '0.3.0',
        paymasterOptions: {
          paymasterUrl: fixtures.PAYMASTER_URL,
          paymasterAddress: fixtures.PAYMASTER_ADDRESS,
          paymasterTokenAddress: fixtures.PAYMASTER_TOKEN_ADDRESS
        }
      })

      const enableModulesData = viem.encodeFunctionData({
        abi: constants.ABI,
        functionName: 'enableModules',
        args: [[safe4337ModuleAddress]]
      })
      const approveData = viem.encodeFunctionData({
        abi: constants.ABI,
        functionName: 'approve',
        args: [
          fixtures.PAYMASTER_ADDRESS,
          0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn
        ]
      })

      const enable4337ModuleTransaction = {
        to: safeModulesSetupAddress,
        value: '0',
        data: enableModulesData,
        operation: OperationType.DelegateCall
      }

      const approveToPaymasterTransaction = {
        to: fixtures.PAYMASTER_TOKEN_ADDRESS,
        value: '0',
        data: approveData,
        operation: OperationType.Call
      }

      const multiSendData = protocolKit.encodeMultiSendData([
        enable4337ModuleTransaction,
        approveToPaymasterTransaction
      ]) as viem.Hash

      expect(encodeFunctionDataSpy).toHaveBeenNthCalledWith(3, {
        abi: constants.ABI,
        functionName: 'multiSend',
        args: [multiSendData]
      })
      expect(safeCreateSpy).toHaveBeenCalledWith({
        provider: safe4337Pack.protocolKit.getSafeProvider().provider,
        signer: safe4337Pack.protocolKit.getSafeProvider().signer,
        predictedSafe: {
          safeDeploymentConfig: {
            safeVersion: constants.DEFAULT_SAFE_VERSION,
            saltNonce: undefined
          },
          safeAccountConfig: {
            owners: [fixtures.OWNER_1],
            threshold: 1,
            to: await safe4337Pack.protocolKit.getMultiSendAddress(),
            data: viem.encodeFunctionData({
              abi: constants.ABI,
              functionName: 'multiSend',
              args: [multiSendData]
            }),
            fallbackHandler: safe4337ModuleAddress,
            paymentToken: viem.zeroAddress,
            payment: 0,
            paymentReceiver: viem.zeroAddress
          }
        }
      })
    })
  })

  describe('When creating a new SafeOperation', () => {
    let safe4337Pack: Safe4337Pack
    let transferUSDC: MetaTransactionData

    beforeAll(async () => {
      safe4337Pack = await createSafe4337Pack({
        options: {
          safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE
        },
        safeModulesVersion: '0.3.0'
      })

      transferUSDC = {
        to: fixtures.PAYMASTER_TOKEN_ADDRESS,
        data: generateTransferCallData(fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE, 100_000n),
        value: '0',
        operation: 0
      }
    })

    it('should allow to use a transaction batch', async () => {
      const transactions = [transferUSDC, transferUSDC]

      const safeOperation = await safe4337Pack.createTransaction({
        transactions
      })

      expect(safeOperation).toBeInstanceOf(BaseSafeOperation)
      expect(safeOperation.getSafeOperation()).toMatchObject({
        safe: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE,
        entryPoint: fixtures.ENTRYPOINT_ADDRESS_V07,
        initCode: '0x',
        paymasterAndData: '0x',
        callData: viem.encodeFunctionData({
          abi: constants.ABI,
          functionName: 'executeUserOp',
          args: [
            safe4337Pack.protocolKit.getMultiSendAddress(),
            0n,
            viem.encodeFunctionData({
              abi: constants.ABI,
              functionName: 'multiSend',
              args: [protocolKit.encodeMultiSendData(transactions) as viem.Hex]
            }),
            OperationType.DelegateCall
          ]
        }),
        nonce: '1',
        callGasLimit: 100000n,
        validAfter: 0,
        validUntil: 0,
        maxFeePerGas: 100000n,
        maxPriorityFeePerGas: 200000n,
        verificationGasLimit: 100000n,
        preVerificationGas: 100000n
      })
    })

    it('should allow to use a single transaction', async () => {
      const safeOperation = await safe4337Pack.createTransaction({
        transactions: [transferUSDC]
      })

      expect(safeOperation).toBeInstanceOf(BaseSafeOperation)
      expect(safeOperation.getSafeOperation()).toMatchObject({
        safe: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE,
        entryPoint: fixtures.ENTRYPOINT_ADDRESS_V07,
        initCode: '0x',
        paymasterAndData: '0x',
        callData: viem.encodeFunctionData({
          abi: constants.ABI,
          functionName: 'executeUserOp',
          args: [
            transferUSDC.to,
            BigInt(transferUSDC.value),
            transferUSDC.data as viem.Hex,
            OperationType.Call
          ]
        }),
        nonce: '1',
        callGasLimit: 100000n,
        validAfter: 0,
        validUntil: 0,
        maxFeePerGas: 100000n,
        maxPriorityFeePerGas: 200000n,
        verificationGasLimit: 100000n,
        preVerificationGas: 100000n
      })
    })

    it('should fill the initCode property when the Safe does not exist', async () => {
      const safe4337Pack = await createSafe4337Pack({
        options: {
          owners: [fixtures.OWNER_1],
          threshold: 1
        },
        safeModulesVersion: '0.3.0'
      })

      const getInitCodeSpy = jest.spyOn(safe4337Pack.protocolKit, 'getInitCode')

      const safeOperation = await safe4337Pack.createTransaction({
        transactions: [transferUSDC]
      })

      expect(getInitCodeSpy).toHaveBeenCalled()
      expect(safeOperation.getSafeOperation().initCode).toBe(
        '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec671688f0b900000000000000000000000029fcb43b46531bca003ddc8fcb67ffe91900c7620000000000000000000000000000000000000000000000000000000000000060ad27de2a410652abce96ea0fdfc30c2f0fd35952b78f554667111999a28ff33800000000000000000000000000000000000000000000000000000000000001e4b63e800d000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000010000000000000000000000002dd68b007b46fbe91b9a7c3eda5a7a1063cb5b47000000000000000000000000000000000000000000000000000000000000014000000000000000000000000075cf11467937ce3f2f357ce24ffc3dbf8fd5c2260000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000ffac5578be8ac1b2b9d13b34caf4a074b96b8a1b00000000000000000000000000000000000000000000000000000000000000648d0dc49f0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000100000000000000000000000075cf11467937ce3f2f357ce24ffc3dbf8fd5c2260000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
      )
    })

    it('should allow to create a sponsored transaction', async () => {
      const safe4337Pack = await createSafe4337Pack({
        options: {
          safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE
        },
        safeModulesVersion: '0.3.0',
        paymasterOptions: {
          isSponsored: true,
          paymasterUrl: fixtures.PAYMASTER_URL
        }
      })

      const sponsoredSafeOperation = await safe4337Pack.createTransaction({
        transactions: [transferUSDC]
      })

      expect(sponsoredSafeOperation).toBeInstanceOf(BaseSafeOperation)
      expect(sponsoredSafeOperation.getSafeOperation()).toMatchObject({
        safe: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE,
        entryPoint: fixtures.ENTRYPOINT_ADDRESS_V07,
        initCode: '0x',
        paymasterAndData: '0x',
        callData: viem.encodeFunctionData({
          abi: constants.ABI,
          functionName: 'executeUserOp',
          args: [
            transferUSDC.to,
            BigInt(transferUSDC.value),
            transferUSDC.data as viem.Hex,
            OperationType.Call
          ]
        }),
        nonce: '1',
        callGasLimit: 100000n,
        validAfter: 0,
        validUntil: 0,
        maxFeePerGas: 100000n,
        maxPriorityFeePerGas: 200000n,
        verificationGasLimit: 100000n,
        preVerificationGas: 100000n
      })
    })

    it('should add the approve transaction to the batch when amountToApprove is provided', async () => {
      const safe4337Pack = await createSafe4337Pack({
        options: {
          safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE
        },
        safeModulesVersion: '0.3.0',
        paymasterOptions: {
          paymasterUrl: fixtures.PAYMASTER_URL,
          paymasterTokenAddress: fixtures.PAYMASTER_TOKEN_ADDRESS,
          paymasterAddress: fixtures.PAYMASTER_ADDRESS
        }
      })

      const amountToApprove = 80_000n

      const sponsoredSafeOperation = await safe4337Pack.createTransaction({
        transactions: [transferUSDC],
        options: {
          amountToApprove
        }
      })

      const approveTransaction = {
        to: fixtures.PAYMASTER_TOKEN_ADDRESS,
        data: viem.encodeFunctionData({
          abi: constants.ABI,
          functionName: 'approve',
          args: [fixtures.PAYMASTER_ADDRESS, amountToApprove]
        }),
        value: '0',
        operation: OperationType.Call // Call for approve
      }

      const batch = [transferUSDC, approveTransaction]

      expect(sponsoredSafeOperation).toBeInstanceOf(BaseSafeOperation)
      expect(sponsoredSafeOperation.getSafeOperation()).toMatchObject({
        safe: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE,
        entryPoint: fixtures.ENTRYPOINT_ADDRESS_V07,
        initCode: '0x',
        paymasterAndData:
          '0x0000000000325602a77416A16136FDafd04b299f0000000000000000000000000000000000000000000000000000000000000000',
        callData: viem.encodeFunctionData({
          abi: constants.ABI,
          functionName: 'executeUserOp',
          args: [
            safe4337Pack.protocolKit.getMultiSendAddress(),
            0n,
            viem.encodeFunctionData({
              abi: constants.ABI,
              functionName: 'multiSend',
              args: [protocolKit.encodeMultiSendData(batch) as viem.Hex]
            }),
            OperationType.DelegateCall
          ]
        }),
        nonce: '1',
        callGasLimit: 100000n,
        validAfter: 0,
        validUntil: 0,
        maxFeePerGas: 100000n,
        maxPriorityFeePerGas: 200000n,
        verificationGasLimit: 100000n,
        preVerificationGas: 100000n
      })
    })
  })

  describe('When using a passkey signer', () => {
    const SAFE_WEBAUTHN_SHARED_SIGNER_ADDRESS = '0x94a4F6affBd8975951142c3999aEAB7ecee555c2'
    const CUSTOM_P256_VERIFIER_ADDRESS = '0xcA89CBa4813D5B40AeC6E57A30d0Eeb500d6531b'
    const PASSKEY_PRIVATE_KEY = BigInt(process.env.PASSKEY_PRIVATE_KEY!)
    jest.setTimeout(120_000)

    let passkey: protocolKit.PasskeyArgType

    beforeAll(async () => {
      if (!global.crypto) {
        global.crypto = crypto as unknown as Crypto
      }

      const webAuthnCredentials = new WebAuthnCredentials(PASSKEY_PRIVATE_KEY)

      passkey = await createMockPasskey('chucknorris', webAuthnCredentials)

      passkey.customVerifierAddress = CUSTOM_P256_VERIFIER_ADDRESS

      Object.defineProperty(global, 'navigator', {
        value: {
          credentials: {
            create: jest
              .fn()
              .mockImplementation(webAuthnCredentials.create.bind(webAuthnCredentials)),
            get: jest.fn().mockImplementation(webAuthnCredentials.get.bind(webAuthnCredentials))
          }
        },
        writable: true
      })
    })

    it('should include a passkey configuration transaction to SafeWebAuthnSharedSigner contract in a multiSend call', async () => {
      const encodeFunctionDataSpy = jest.spyOn(viem, 'encodeFunctionData')
      const safeCreateSpy = jest.spyOn(Safe, 'init')

      const safe4337Pack = await createSafe4337Pack({
        signer: passkey,
        options: {
          owners: [fixtures.OWNER_1],
          threshold: 1
        },
        safeModulesVersion: '0.3.0'
      })

      const passkeyOwnerConfiguration = {
        x: BigInt(passkey.coordinates.x),
        y: BigInt(passkey.coordinates.y),
        verifiers: viem.fromHex(CUSTOM_P256_VERIFIER_ADDRESS, 'bigint')
      }
      const enableModulesData = viem.encodeFunctionData({
        abi: constants.ABI,
        functionName: 'enableModules',
        args: [[safe4337ModuleAddress]]
      })

      const passkeyConfigureData = viem.encodeFunctionData({
        abi: constants.ABI,
        functionName: 'configure',
        args: [passkeyOwnerConfiguration]
      })

      const enable4337ModuleTransaction = {
        to: safeModulesSetupAddress,
        value: '0',
        data: enableModulesData,
        operation: OperationType.DelegateCall
      }

      const sharedSignerTransaction = {
        to: SAFE_WEBAUTHN_SHARED_SIGNER_ADDRESS,
        value: '0',
        data: passkeyConfigureData,
        operation: OperationType.DelegateCall
      }

      const multiSendData = protocolKit.encodeMultiSendData([
        enable4337ModuleTransaction,
        sharedSignerTransaction
      ])

      expect(encodeFunctionDataSpy).toHaveBeenNthCalledWith(2, {
        functionName: 'configure',
        abi: viem.parseAbi([
          'function configure((uint256 x, uint256 y, uint176 verifiers) signer)'
        ]),
        args: [passkeyOwnerConfiguration]
      })

      expect(encodeFunctionDataSpy).toHaveBeenNthCalledWith(3, {
        functionName: 'multiSend',
        abi: constants.ABI,
        args: [multiSendData]
      })

      expect(safeCreateSpy).toHaveBeenCalledWith({
        provider: safe4337Pack.protocolKit.getSafeProvider().provider,
        signer: passkey,
        predictedSafe: {
          safeDeploymentConfig: {
            safeVersion: constants.DEFAULT_SAFE_VERSION,
            saltNonce: undefined
          },
          safeAccountConfig: {
            owners: [fixtures.OWNER_1, SAFE_WEBAUTHN_SHARED_SIGNER_ADDRESS],
            threshold: 1,
            to: safe4337Pack.protocolKit.getMultiSendAddress(),
            data: viem.encodeFunctionData({
              abi: constants.ABI,
              functionName: 'multiSend',
              args: [multiSendData as viem.Hex]
            }),
            fallbackHandler: safe4337ModuleAddress,
            paymentToken: viem.zeroAddress,
            payment: 0,
            paymentReceiver: viem.zeroAddress
          }
        }
      })
    })

    it('should allow to sign a SafeOperation', async () => {
      const transferUSDC = {
        to: fixtures.PAYMASTER_TOKEN_ADDRESS,
        data: generateTransferCallData(fixtures.SAFE_ADDRESS_4337_PASSKEY, 100_000n),
        value: '0',
        operation: 0
      }

      const safe4337Pack = await createSafe4337Pack({
        signer: passkey,
        options: {
          owners: [],
          threshold: 1
        }
      })

      const safeOperation = await safe4337Pack.createTransaction({
        transactions: [transferUSDC]
      })

      const safeOpHash = safeOperation.getHash()

      const passkeySignature = await safe4337Pack.protocolKit.signHash(safeOpHash)

      expect(await safe4337Pack.signSafeOperation(safeOperation)).toMatchObject({
        signatures: new Map().set(
          SAFE_WEBAUTHN_SHARED_SIGNER_ADDRESS.toLowerCase(),
          new protocolKit.EthSafeSignature(
            SAFE_WEBAUTHN_SHARED_SIGNER_ADDRESS,
            passkeySignature.data,
            true
          )
        )
      })
    })

    it('should allow to send an UserOperation to a bundler', async () => {
      const transferUSDC = {
        to: fixtures.PAYMASTER_TOKEN_ADDRESS,
        data: generateTransferCallData(fixtures.SAFE_ADDRESS_4337_PASSKEY, 100_000n),
        value: '0',
        operation: 0
      }

      const safe4337Pack = await createSafe4337Pack({
        signer: passkey,
        options: {
          safeAddress: fixtures.SAFE_ADDRESS_4337_PASSKEY
        }
      })

      let safeOperation = await safe4337Pack.createTransaction({
        transactions: [transferUSDC]
      })
      safeOperation = await safe4337Pack.signSafeOperation(safeOperation)

      await safe4337Pack.executeTransaction({ executable: safeOperation })

      expect(requestMock).toHaveBeenCalledWith({
        method: constants.RPC_4337_CALLS.SEND_USER_OPERATION,
        params: [
          utils.userOperationToHexValues(
            safeOperation.getUserOperation(),
            fixtures.ENTRYPOINT_ADDRESS_V06
          ),
          fixtures.ENTRYPOINT_ADDRESS_V06
        ]
      })
    })
  })

  it('should use the default module version when safeModuleVersion is not provided', async () => {
    const safe4337Pack = await createSafe4337Pack({
      options: {
        safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE
      },
      safeModulesVersion: '0.3.0'
    })

    expect(await safe4337Pack.protocolKit.getFallbackHandler()).toBe(
      fixtures.SAFE_4337_MODULE_ADDRESS_V0_3_0
    )
  })

  it('should allow to sign a SafeOperation', async () => {
    const transferUSDC = {
      to: fixtures.PAYMASTER_TOKEN_ADDRESS,
      data: generateTransferCallData(fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE, 100_000n),
      value: '0',
      operation: 0
    }

    const safe4337Pack = await createSafe4337Pack({
      options: {
        safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE
      },
      safeModulesVersion: '0.3.0'
    })

    const safeOperation = await safe4337Pack.createTransaction({
      transactions: [transferUSDC]
    })

    expect(await safe4337Pack.signSafeOperation(safeOperation)).toMatchObject({
      signatures: new Map().set(
        fixtures.OWNER_1.toLowerCase(),
        new protocolKit.EthSafeSignature(
          fixtures.OWNER_1,
          '0x341b48cbc73a74905d3e52f96329cd994043b8cc261d5f2d2fc87875c6a0e987241e09f0ceb7a061e6c058e65fd3e2f9d3b47f56cad00c4e02cf62fed012a8bb1c',
          false
        )
      )
    })
  })

  it('should allow to sign a SafeOperation using a SafeOperationResponse object from the api to add a signature', async () => {
    const safe4337Pack = await createSafe4337Pack({
      options: {
        safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE
      },
      safeModulesVersion: '0.3.0'
    })

    expect(await safe4337Pack.signSafeOperation(fixtures.SAFE_OPERATION_RESPONSE)).toMatchObject({
      signatures: new Map()
        .set(
          fixtures.OWNER_1.toLowerCase(),
          new protocolKit.EthSafeSignature(
            fixtures.OWNER_1,
            '0x6fa024afd110bee3832dd9507b5ce2bf1bb097363ba63b887b1a44f5a7b89e3b5d32ff9dbb5fee63f0bf44df1b427d7a7e69451b3c05d25fb49f77fe2fd044141b',
            false
          )
        )
        .set(
          fixtures.OWNER_2.toLowerCase(),
          new protocolKit.EthSafeSignature(
            fixtures.OWNER_2,
            '0xcb28e74375889e400a4d8aca46b8c59e1cf8825e373c26fa99c2fd7c078080e64fe30eaf1125257bdfe0b358b5caef68aa0420478145f52decc8e74c979d43ab1d',
            false
          )
        )
    })
  })

  it('should allow to send an UserOperation to a bundler', async () => {
    const transferUSDC = {
      to: fixtures.PAYMASTER_TOKEN_ADDRESS,
      data: generateTransferCallData(fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE, 100_000n),
      value: '0',
      operation: 0
    }

    const safe4337Pack = await createSafe4337Pack({
      options: {
        safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE
      },
      safeModulesVersion: '0.3.0'
    })
    const readContractSpy = jest.spyOn(safe4337Pack.protocolKit.getSafeProvider(), 'readContract')

    let safeOperation = await safe4337Pack.createTransaction({
      transactions: [transferUSDC]
    })
    expect(readContractSpy).toHaveBeenCalledWith({
      address: constants.ENTRYPOINT_ADDRESS_V07,
      abi: constants.ENTRYPOINT_ABI,
      functionName: 'getNonce',
      args: [fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE, 0n]
    })

    safeOperation = await safe4337Pack.signSafeOperation(safeOperation)

    await safe4337Pack.executeTransaction({ executable: safeOperation })

    expect(requestMock).toHaveBeenCalledWith({
      method: constants.RPC_4337_CALLS.SEND_USER_OPERATION,
      params: [
        utils.userOperationToHexValues(
          safeOperation.getUserOperation(),
          fixtures.ENTRYPOINT_ADDRESS_V07
        ),
        fixtures.ENTRYPOINT_ADDRESS_V07
      ]
    })
  })

  it('should allow to send a UserOperation to the bundler using a SafeOperationResponse object from the api', async () => {
    const safe4337Pack = await createSafe4337Pack({
      options: {
        safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_2_0_MODULE
      }
    })

    await safe4337Pack.executeTransaction({ executable: fixtures.SAFE_OPERATION_RESPONSE })

    expect(requestMock).toHaveBeenCalledWith({
      method: constants.RPC_4337_CALLS.SEND_USER_OPERATION,
      params: [
        utils.userOperationToHexValues(
          {
            sender: '0xE322e721bCe76cE7FCf3A475f139A9314571ad3D',
            nonce: '3',
            initCode: '0x',
            callData:
              '0x7bb37428000000000000000000000000e322e721bce76ce7fcf3a475f139a9314571ad3d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
            callGasLimit: 122497n,
            verificationGasLimit: 123498n,
            preVerificationGas: 50705n,
            maxFeePerGas: 105183831060n,
            maxPriorityFeePerGas: 1380000000n,
            paymasterAndData: '0x',
            signature:
              '0x000000000000000000000000cb28e74375889e400a4d8aca46b8c59e1cf8825e373c26fa99c2fd7c078080e64fe30eaf1125257bdfe0b358b5caef68aa0420478145f52decc8e74c979d43ab1d'
          },
          fixtures.ENTRYPOINT_ADDRESS_V06
        ),
        fixtures.ENTRYPOINT_ADDRESS_V06
      ]
    })
  })

  it('should return a UserOperation based on a userOpHash', async () => {
    const safe4337Pack = await createSafe4337Pack({
      options: {
        safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE
      },
      safeModulesVersion: '0.3.0'
    })

    const { userOperation, entryPoint, transactionHash, blockHash, blockNumber } =
      await safe4337Pack.getUserOperationByHash(
        '0xee8e07f229d0ebf11c84a3e40f87e1d1b4c7b18eaeaebf3babb4b479424823e6'
      )

    expect(userOperation).toMatchObject({
      sender: '0x1405B3659a11a16459fc27Fa1925b60388C38Ce1',
      nonce: '0x1',
      initCode: '0x',
      callData:
        '0x7bb3742800000000000000000000000038869bf66a61cf6bdb996a6ae40d5853fd43b52600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000001848d80ff0a00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000132001c7d4b196cb0c7b01d743fbc6116a902379c723800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000d725e11588f040d86c4c49d8236e32a5868549f000000000000000000000000000000000000000000000000000000000000186a0001c7d4b196cb0c7b01d743fbc6116a902379c723800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000d725e11588f040d86c4c49d8236e32a5868549f000000000000000000000000000000000000000000000000000000000000186a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
      callGasLimit: '0x1d7d0',
      verificationGasLimit: '0x14470',
      preVerificationGas: '0xbdb8',
      maxFeePerGas: '0x2d128cfa8c',
      maxPriorityFeePerGas: '0x52412100',
      paymasterAndData: '0x',
      signature:
        '0x000000000000000000000000a397ca32ee7fb5282256ee3465da0843485930b803d747516aac76e152f834051ac18fd2b3c0565590f9d65085538993c85c9bb189c940d15c15402c7c2885821b'
    })

    expect(blockHash).toBe('0x65f8249337ffede2067a006a96da47d3d3445ca72492a6a82afa02899f05d2e5')
    expect(blockNumber).toBe('0x5378b9')
    expect(entryPoint).toBe('0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789')
    expect(transactionHash).toBe(
      '0xef262d20f68e4900aa6380b8ac0f66f9c00a7d988179fa177ad9c9758f0e380e'
    )
  })

  it('should return a UserOperation receipt based on a userOpHash', async () => {
    const safe4337Pack = await createSafe4337Pack({
      options: {
        safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE
      },
      safeModulesVersion: '0.3.0'
    })

    const userOperationReceipt = await safe4337Pack.getUserOperationReceipt(
      '0xee8e07f229d0ebf11c84a3e40f87e1d1b4c7b18eaeaebf3babb4b479424823e6'
    )

    expect(userOperationReceipt?.userOpHash).toBe(
      '0x3cb881d1969036174f38d636d22108d1d032145518b53104fc0b1e1296d2cc9c'
    )
    expect(userOperationReceipt?.sender).toBe('0x1405B3659a11a16459fc27Fa1925b60388C38Ce1')
    expect(userOperationReceipt?.actualGasUsed).toBe('0x27067')
    expect(userOperationReceipt?.actualGasCost).toBe('0x42f29418377167')
    expect(userOperationReceipt?.success).toBe(true)
    expect(userOperationReceipt?.logs).toStrictEqual([])

    expect(userOperationReceipt?.receipt).toMatchObject({
      transactionHash: '0xef262d20f68e4900aa6380b8ac0f66f9c00a7d988179fa177ad9c9758f0e380e',
      transactionIndex: '0x63',
      blockHash: '0x65f8249337ffede2067a006a96da47d3d3445ca72492a6a82afa02899f05d2e5',
      blockNumber: '0x5378b9',
      from: '0x4337001Fff419768e088Ce247456c1B892888084',
      to: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
      cumulativeGasUsed: '0xc1a846',
      gasUsed: '0x25e6c',
      contractAddress: null,
      logs: [],
      logsBloom:
        '0x000000000000900000000000000000000000000000000000080000000002000000080000000000000402000100000000001000000000000080000200000100000000000000000000000000080000000000000000000000000000002000002000000000000a0000000000000000000800000000000000000000000010000200000000000060100000000000000040000000800000000000000008800000000000000000000000000000400000000000000200000000000000000002000000008000000002000100000001000000000000000000000020000000000000000020010040000000000020000010000008000200000000000000000000000000000000',
      status: '0x1',
      effectiveGasPrice: '0x1b67f3c201'
    })
  })

  it('should return an array of the entryPoint addresses supported by the client', async () => {
    const safe4337Pack = await createSafe4337Pack({
      options: {
        safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE
      },
      safeModulesVersion: '0.3.0'
    })

    const supportedEntryPoints = await safe4337Pack.getSupportedEntryPoints()

    expect(supportedEntryPoints).toContain('0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789')
  })

  describe('When using the onChainAnalytics feature', () => {
    it("should enable to generate on chain analytics data for a Safe's transactions", async () => {
      const safe4337Pack = await createSafe4337Pack({
        onchainAnalytics: {
          project: 'Test Relay kit',
          platform: 'Web'
        },
        options: {
          safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE
        },
        safeModulesVersion: '0.3.0'
      })

      const onchainIdentifier = await safe4337Pack.getOnchainIdentifier()

      expect(onchainIdentifier).toBeDefined()

      const identifierWithoutToolVersion = onchainIdentifier.slice(0, -6)

      expect(identifierWithoutToolVersion).toBe(
        '5afe006137303238633936636562316132623939353333646561393063'
      )

      const relayKitCurrentVersion = utils.getRelayKitVersion()

      // check the tool version hash
      const toolversionHash = viem
        .toHex(viem.keccak256(viem.toHex(relayKitCurrentVersion)).slice(-3))
        .replace('0x', '')
      expect(onchainIdentifier.endsWith(toolversionHash)).toBeTruthy()
    })

    it('should include th onchain identifier at the end of the callData property', async () => {
      const safe4337Pack = await createSafe4337Pack({
        onchainAnalytics: {
          project: 'Test Relay kit',
          platform: 'Web'
        },
        options: {
          safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE
        },
        safeModulesVersion: '0.3.0'
      })

      const transferUSDC = {
        to: fixtures.PAYMASTER_TOKEN_ADDRESS,
        data: generateTransferCallData(fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE, 100_000n),
        value: '0',
        operation: 0
      }

      const safeOperation = await safe4337Pack.createTransaction({
        transactions: [transferUSDC]
      })

      const onchainIdentifier = await safe4337Pack.getOnchainIdentifier()

      expect(onchainIdentifier).toBeDefined()
      expect(safeOperation.userOperation.callData.endsWith(onchainIdentifier)).toBeTruthy()

      const identifierWithoutToolVersion = onchainIdentifier.slice(0, -6)

      expect(identifierWithoutToolVersion).toBe(
        '5afe006137303238633936636562316132623939353333646561393063'
      )
    })

    it('should allow to use custom nonces', async () => {
      const transferUSDC = {
        to: fixtures.PAYMASTER_TOKEN_ADDRESS,
        data: generateTransferCallData(fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE, 100_000n),
        value: '0',
        operation: 0
      }

      const safe4337Pack = await createSafe4337Pack({
        options: {
          safeAddress: fixtures.SAFE_ADDRESS_v1_4_1_WITH_0_3_0_MODULE
        },
        safeModulesVersion: '0.3.0'
      })

      const customNonce = utils.encodeNonce({
        key: BigInt(Date.now()),
        sequence: 0n
      })

      let safeOperation = await safe4337Pack.createTransaction({
        transactions: [transferUSDC],
        options: { customNonce }
      })

      expect(safeOperation.getUserOperation()).toHaveProperty('nonce', customNonce.toString())
      expect(safeOperation.getSafeOperation()).toHaveProperty('nonce', customNonce.toString())

      safeOperation = await safe4337Pack.signSafeOperation(safeOperation)
    })
  })
})
