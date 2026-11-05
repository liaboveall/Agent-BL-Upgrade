import { useLang } from '../state/hooks.js';
import { Disclosure } from './ui.jsx';

// "Verified" is used for several different things in this application. They are four kinds of assurance, each with its own
// limit; none of them includes whether the cargo, the title or the valuation is true.
const LEVELS = [
  { id: 'rule', zh: ['规则检查', '应用按固定规则核对字段、日期、金额和权限。', '只说明材料自洽、符合规则；不说明材料为真。'],
    en: ['Rule check', 'The application checks fields, dates, amounts and permissions against fixed rules.', 'It shows the material is consistent and follows the rules, not that it is true.'] },
  { id: 'chain', zh: ['链上证据', '交易已上链，或承诺（哈希）与链上记录一致，合约预执行通过。', '只说明这笔调用或这份文件没有被改动；不证明货物、单证或估值真实。'],
    en: ['On-chain evidence', 'A transaction is mined, or a commitment (hash) matches the chain, or a contract preflight passed.', 'It shows this call or file was not altered; it does not prove the cargo, the title or the valuation.'] },
  { id: 'review', zh: ['人工审查', '指定角色（审查人、估值人、合规方）签署或批准。', '是该角色自己的声明，质量取决于这个人或机构；本原型的研究签名不代表可变现价格。'],
    en: ['Human review', 'A named role (reviewer, valuer, compliance) signs or approves.', 'It is that role’s own statement and is only as good as that person or organization; a research signature is not a realizable price.'] },
  { id: 'external', zh: ['未验证的外部事实', '货物是否存在、单证真伪与处置权、可实现的处置价值、数据供应商质量。', '本研究原型不验证这些，也不保证偿付。'],
    en: ['Unverified external facts', 'Whether the cargo exists, the title is genuine and disposable, what a disposal would realize, and the quality of data suppliers.', 'This research prototype verifies none of these and guarantees no repayment.'] }
];

/** What each kind of "verified" does and does not show, in one place a reader can open next to any such claim. */
export function AssuranceLevels() {
  const zh = useLang() === 'zh';
  return (
    <Disclosure summary={zh ? '“已核验”是哪一种？四种保证，各有边界' : 'Which kind of “verified”? Four kinds of assurance, each with a limit'} className="value-bases assurance-levels">
      <dl>
        {LEVELS.map((level) => {
          const [name, means, limit] = level[zh ? 'zh' : 'en'];
          return <div key={level.id} data-assurance={level.id}><dt>{name}</dt><dd>{means}<small>{limit}</small></dd></div>;
        })}
      </dl>
    </Disclosure>
  );
}
