import { STATE, ACTION, TARGET, ISSUE_PRICE, send, uniqueHash, deployProtocol as deployProtocolV4, ethers } from './protocol.js';

export { STATE, ACTION, TARGET, ISSUE_PRICE, send, uniqueHash, ethers };

export async function deployProtocolV5() {
  const ctx = await deployProtocolV4();
  const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
  await usdc.waitForDeployment();
  const token = await (await ethers.getContractFactory('RWATokenV5')).deploy();
  await token.waitForDeployment();
  const pool = await (await ethers.getContractFactory('RWAOfferingPoolV5')).deploy(
    await ctx.registry.getAddress(),
    await token.getAddress()
  );
  await pool.waitForDeployment();
  await send(token.setPool(await pool.getAddress()));
  await send(pool.setOracle(await ctx.oracle.getAddress()));
  await send(pool.setAgentExecutor(ctx.agent.address, true));
  // Use a signer distinct from the v4 roles for the exporter/disbursement recipient.
  const [, , , , , , exporter] = await ethers.getSigners();
  return { ...ctx, exporter, usdc, token, pool };
}

export async function newOfferingV5(ctx, tag, {
  supply = 100n, issuePrice = ISSUE_PRICE, target = TARGET,
  maturityIn = 1_000, deadlineIn = 100, minRaise = (supply * issuePrice * 80n) / 100n
} = {}) {
  await send(ctx.registry.mintEBL(ethers.id(`metadata:${tag}`), ctx.owner.address));
  const eblId = (await ctx.registry.nextEblId()) - 1n;
  await send(ctx.registry.pledge(eblId, await ctx.pool.getAddress()));
  const start = (await ethers.provider.getBlock('latest')).timestamp;
  const maturity = BigInt(start) + BigInt(maturityIn);
  const deadline = BigInt(start) + BigInt(deadlineIn);
  await send(ctx.pool.createOfferingWithTerms(eblId, supply, issuePrice, target, maturity, deadline, await ctx.usdc.getAddress(), minRaise));
  return { eblId, poolId: (await ctx.pool.nextPoolId()) - 1n, maturity, deadline };
}
