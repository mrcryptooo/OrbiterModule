import { createAlchemyWeb3 } from '@alch/alchemy-web3'
import axios from 'axios'
import { BigNumber } from 'bignumber.js'
import Web3 from 'web3'
import { makerConfig } from '../config'
import { ServiceError, ServiceErrorCodes } from '../error/service'
import { MakerWealth } from '../model/maker_wealth'
import { isEthTokenAddress } from '../util'
import { Core } from '../util/core'
import { errorLogger } from '../util/logger'
import { getMakerList } from '../util/maker'
import { CHAIN_INDEX } from '../util/maker/core'
import { DydxHelper } from './dydx/dydx_helper'
import { IMXHelper } from './immutablex/imx_helper'
import { getErc20BalanceByL1, getNetworkIdByChainId } from './starknet/helper'

const repositoryMakerWealth = () => Core.db.getRepository(MakerWealth)

export const CACHE_KEY_GET_WEALTHS = 'GET_WEALTHS'

/**
 *
 * @param makerAddress
 * @param chainId
 * @param chainName
 * @param tokenAddress
 * @param tokenName for match zksync result
 */
async function getTokenBalance(
  makerAddress: string,
  chainId: number,
  chainName: string,
  tokenAddress: string,
  tokenName: string
): Promise<string | undefined> {
  let value: string | undefined
  try {
    switch (CHAIN_INDEX[chainId]) {
      case 'zksync':
        {
          let api = makerConfig.zksync.api
          if (chainId == 33) {
            api = makerConfig.zksync_test.api
          }

          const respData = (
            await axios.get(
              `${api.endPoint}/accounts/${makerAddress}/committed`
            )
          ).data

          if (respData.status == 'success' && respData?.result?.balances) {
            value = respData.result.balances[tokenName.toUpperCase()]
          }
        }
        break
      case 'loopring':
        {
          let api = makerConfig.loopring.api
          let accountID: Number | undefined
          if (chainId === 99) {
            api = makerConfig.loopring_test.api
          }
          // getAccountID first
          const accountInfo = await axios(
            `${api.endPoint}/account?owner=${makerAddress}`
          )
          if (accountInfo.status == 200 && accountInfo.statusText == 'OK') {
            accountID = accountInfo.data.accountId
          }

          const balanceData = await axios.get(
            `${api.endPoint}/user/balances?accountId=${accountID}&tokens=0`
          )
          if (balanceData.status == 200 && balanceData.statusText == 'OK') {
            if (!Array.isArray(balanceData.data)) {
              value = '0'
            }
            if (balanceData.data.length == 0) {
              value = '0'
            }
            let balanceMap = balanceData.data[0]
            let totalBalance = balanceMap.total ? balanceMap.total : 0
            let locked = balanceMap.locked ? balanceMap.locked : 0
            let withDraw = balanceMap.withDraw ? balanceMap.withDraw : 0
            value = totalBalance - locked - withDraw + ''
          }
        }
        break
      case 'starknet':
        const networkId = getNetworkIdByChainId(chainId)
        value = String(
          await getErc20BalanceByL1(makerAddress, tokenAddress, networkId)
        )
        break
      case 'immutablex':
        const imxHelper = new IMXHelper(chainId)
        value = (
          await imxHelper.getBalanceBySymbol(makerAddress, tokenName)
        ).toString()
        break
      case 'metis':
        const web3 = new Web3(makerConfig[chainName]?.httpEndPoint)
        if (tokenAddress) {
          value = await getBalanceByMetis(web3, makerAddress, tokenAddress)
        } else {
          value = await web3.eth.getBalance(
            makerAddress
          )
        }
        break
      case 'dydx':
        const apiKeyCredentials = DydxHelper.getApiKeyCredentials(makerAddress)
        if (!apiKeyCredentials) {
          break
        }
        const dydxHelper = new DydxHelper(chainId)
        const dydxClient = await dydxHelper.getDydxClient(makerAddress)
        dydxClient.apiKeyCredentials = apiKeyCredentials

        value = (await dydxHelper.getBalanceUsdc(makerAddress)).toString()
        break
      default:
        const alchemyUrl = makerConfig[chainName]?.httpEndPoint
        if (!alchemyUrl) {
          break
        }

        // when empty tokenAddress or 0x00...000, get eth balances
        if (!tokenAddress || isEthTokenAddress(tokenAddress)) {
          value = await createAlchemyWeb3(alchemyUrl).eth.getBalance(
            makerAddress
          )
        } else {
          const resp = await createAlchemyWeb3(
            alchemyUrl
          ).alchemy.getTokenBalances(makerAddress, [tokenAddress])

          for (const item of resp.tokenBalances) {
            if (item.error) {
              continue
            }

            value = String(item.tokenBalance)

            // Now only one
            break
          }
        }
        break
    }
  } catch (error) {
    errorLogger.error(
      `GetTokenBalance fail, chainId: ${chainId}, makerAddress: ${makerAddress}, tokenName: ${tokenName}, error: `,
      error.message
    )
  }

  return value
}

/**
 * @param web3
 * @param makerAddress
 * @param tokenAddress
 * @returns
 */
async function getBalanceByMetis(
  web3: Web3,
  makerAddress: string,
  tokenAddress: string
) {
  const tokenContract = new web3.eth.Contract(
    <any>makerConfig.ABI,
    tokenAddress
  )
  const tokenBalanceWei = await tokenContract.methods
    .balanceOf(makerAddress)
    .call({
      from: makerAddress,
    })
  return tokenBalanceWei
}

type WealthsChain = {
  chainId: number
  chainName: string
  makerAddress: string
  balances: {
    tokenAddress: string
    tokenName: string
    value?: string // When can't get balance(e: Network fail), it is undefined
    decimals: number // for format
  }[]
}
export async function getWealthsChains(makerAddress: string) {
  // check
  if (!makerAddress) {
    throw new ServiceError(
      'Sorry, params makerAddress miss',
      ServiceErrorCodes['arguments invalid']
    )
  }

  const makerList = await getMakerList()
  const wealthsChains: WealthsChain[] = []

  const pushToChainBalances = (
    wChain: WealthsChain,
    tokenAddress: string,
    tokenName: string,
    decimals: number
  ) => {
    const find = wChain.balances.find(
      (item) => item.tokenAddress == tokenAddress
    )
    if (find) {
      return
    }

    wChain.balances.push({ tokenAddress, tokenName, decimals, value: '' })
  }
  const pushToChains = (
    makerAddress: string,
    chainId: number,
    chainName: string
  ): WealthsChain => {
    const find = wealthsChains.find((item) => item.chainId === chainId)
    if (find) {
      return find
    }

    // push chain where no exist
    const item = { makerAddress, chainId, chainName, balances: [] }
    wealthsChains.push(item)

    return item
  }
  for (const item of makerList) {
    if (item.makerAddress != makerAddress) {
      continue
    }

    pushToChainBalances(
      pushToChains(item.makerAddress, item.c1ID, item.c1Name),
      item.t1Address,
      item.tName,
      item.precision
    )
    pushToChainBalances(
      pushToChains(item.makerAddress, item.c2ID, item.c2Name),
      item.t2Address,
      item.tName,
      item.precision
    )
  }

  // get tokan balance
  for (const item of wealthsChains) {
    // add eth
    const ethBalancesItem = item.balances.find((item2) => {
      return !item2.tokenAddress || isEthTokenAddress(item2.tokenAddress)
    })
    if (ethBalancesItem) {
      // clear eth's tokenAddress
      ethBalancesItem.tokenAddress = ''
    } else {
      // add eth balances item
      item.balances.unshift({
        tokenAddress: '',
        tokenName: CHAIN_INDEX[item.chainId] == 'polygon' ? 'MATIC' : 'ETH',
        decimals: 18,
        value: '',
      })
    }
  }

  return wealthsChains
}

/**
 *
 * @param makerAddress
 * @returns
 */
export async function getWealths(
  makerAddress: string
): Promise<WealthsChain[]> {
  const wealthsChains = await getWealthsChains(makerAddress)

  // get tokan balance
  const promises: Promise<void>[] = []
  for (const item of wealthsChains) {
    for (const item2 of item.balances) {
      const promiseItem = async () => {
        let value = await getTokenBalance(
          item.makerAddress,
          item.chainId,
          item.chainName,
          item2.tokenAddress,
          item2.tokenName
        )

        // When value!='' && > 0, format it
        if (value) {
          value = new BigNumber(value)
            .dividedBy(10 ** item2.decimals)
            .toString()
        }

        item2.value = value
      }
      promises.push(promiseItem())
    }
  }

  await Promise.all(promises)

  return wealthsChains
}

/**
 * @param wealths
 * @returns
 */
export async function saveWealths(wealths: WealthsChain[]) {
  for (const item1 of wealths) {
    for (const item2 of item1.balances) {
      await repositoryMakerWealth().insert({
        makerAddress: item1.makerAddress,
        tokenAddress: item2.tokenAddress,
        chainId: item1.chainId,
        balance: item2.value,
        decimals: item2.decimals,
      })
    }
  }
}
