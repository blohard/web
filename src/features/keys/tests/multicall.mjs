import { decodeAbiParameters, decodeFunctionData, deploylessCallViaBytecodeBytecode, encodeFunctionResult, multicall3Abi } from 'viem'

/** Execute the view calls inside viem's deployless multicall at the mocked RPC boundary. */
export async function answerCall(request, read) {
  const call = request.method === 'eth_call' && request.params[0]
  if (!call || call.to || !call.data?.startsWith(deploylessCallViaBytecodeBytecode)) return read(request)
  const [, data] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }],
    `0x${call.data.slice(deploylessCallViaBytecodeBytecode.length)}`)
  const { args: [calls] } = decodeFunctionData({ abi: multicall3Abi, data })
  const result = await Promise.all(calls.map(async ({ target, callData }) => ({
    success: true,
    returnData: await read({ ...request, params: [{ to: target, data: callData }, ...request.params.slice(1)] }),
  })))
  return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result })
}
