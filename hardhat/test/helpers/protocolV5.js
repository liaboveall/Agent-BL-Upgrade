import { STATE, ACTION, TARGET, ISSUE_PRICE, send, uniqueHash, ethers } from './protocol.js';

export { STATE, ACTION, TARGET, ISSUE_PRICE, send, uniqueHash, ethers };

export async function deployProtocolV5() {
  const [owner,investor,outsider,agent,other,third,exporter]=await ethers.getSigners();
  const deploy=async(name,...args)=>(await (await ethers.getContractFactory(name)).deploy(...args)).waitForDeployment();
  const registry=await deploy('MockCapitalRegistry'),usdc=await deploy('MockUSDC'),token=await deploy('ControlledRWAToken');
  const pool=await deploy('RWAOfferingPoolV5',await registry.getAddress(),await token.getAddress());
  await send(token.bindPool(await pool.getAddress()));await send(pool.setAgentExecutor(agent.address,true));
  return {owner,investor,outsider,agent,other,third,exporter,registry,usdc,token,pool};
}

export async function newOfferingV5(ctx, tag, {
  supply = 100n, issuePrice = ISSUE_PRICE, target = TARGET,
  maturityIn = 1_000, deadlineIn = 100, minRaise = (supply * issuePrice * 80n) / 100n, asset = ctx.usdc
} = {}) {
  await send(ctx.registry.mintEBL(ethers.id(`metadata:${tag}`), ctx.owner.address));
  const eblId = (await ctx.registry.nextEblId()) - 1n;
  await send(ctx.registry.pledge(eblId, await ctx.pool.getAddress()));
  const start = (await ethers.provider.getBlock('latest')).timestamp;
  const maturity = BigInt(start) + BigInt(maturityIn);
  const deadline = BigInt(start) + BigInt(deadlineIn);
  await send(ctx.pool.createOfferingWithTerms(eblId, supply, issuePrice, target, maturity, deadline, await asset.getAddress(), minRaise));
  return { eblId, poolId: (await ctx.pool.nextPoolId()) - 1n, maturity, deadline };
}
