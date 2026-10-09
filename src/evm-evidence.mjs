const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const address = (v) => typeof v === 'string' && /^0x[a-f0-9]{40}$/i.test(v);
// Mainnet Ethereum/Base receipt verifier. No credentials, transaction signing or broadcasting.
export function createEvmEvidence({
  rpcUrl,
  chainId,
  tokenContract,
  confirmations = 12,
  fetcher = fetch,
}) {
  const url = new URL(rpcUrl);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !address(tokenContract) ||
    ![1, 8453].includes(chainId) ||
    !Number.isSafeInteger(confirmations) ||
    confirmations < 1
  )
    throw Error('Invalid EVM evidence configuration');
  let id = 0;
  async function rpc(method, params) {
    const r = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(20000),
      redirect: 'manual',
    });
    if (!r.ok) throw Error('Chain evidence unavailable');
    const text = await r.text();
    if (text.length > 512000) throw Error('Chain response too large');
    const body = JSON.parse(text);
    if (body.error || body.result === undefined) throw Error('Chain evidence unavailable');
    return body.result;
  }
  return {
    async transfer(txid, { from, to, amountAtomic }) {
      if (
        !/^0x[a-f0-9]{64}$/i.test(txid) ||
        !address(from) ||
        !address(to) ||
        !/^[1-9][0-9]*$/.test(amountAtomic)
      )
        throw Error('Invalid expected transfer');
      if (BigInt(await rpc('eth_chainId', [])) !== BigInt(chainId)) throw Error('Wrong RPC chain');
      const receipt = await rpc('eth_getTransactionReceipt', [txid]);
      if (
        !receipt ||
        receipt.status !== '0x1' ||
        receipt.transactionHash.toLowerCase() !== txid.toLowerCase()
      )
        throw Error('Transfer not confirmed');
      const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
      const tip = BigInt(await rpc('eth_blockNumber', []));
      if (
        !block ||
        block.hash !== receipt.blockHash ||
        tip - BigInt(receipt.blockNumber) + 1n < BigInt(confirmations)
      )
        throw Error('Transfer not canonical or deep enough');
      const events = receipt.logs.filter(
        (l) =>
          !l.removed &&
          l.address.toLowerCase() === tokenContract.toLowerCase() &&
          l.topics?.length === 3 &&
          l.topics[0].toLowerCase() === transfer &&
          /^0x[0-9a-f]{64}$/i.test(l.topics[1]) &&
          /^0x[0-9a-f]{64}$/i.test(l.topics[2]) &&
          '0x' + l.topics[1].slice(-40).toLowerCase() === from.toLowerCase() &&
          '0x' + l.topics[2].slice(-40).toLowerCase() === to.toLowerCase() &&
          /^0x[0-9a-f]{64}$/i.test(l.data) &&
          BigInt(l.data) === BigInt(amountAtomic),
      );
      if (events.length !== 1) throw Error('Expected transfer missing or ambiguous');
      return {
        canonical: true,
        confirmed: true,
        txid,
        from,
        to,
        amountAtomic,
        blockHash: block.hash,
        blockNumber: receipt.blockNumber,
        logIndex: events[0].logIndex,
      };
    },
  };
}
