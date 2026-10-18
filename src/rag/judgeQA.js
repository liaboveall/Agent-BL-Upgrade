// AgentBL RAG: Judge Q&A Pairs (Mock)
// 4 prepared Q&A pairs for hackathon judge Q&A sessions
// Each pair includes the question, a model answer, search keywords,
// and a pointer to the relevant documentation or source code.

export const JUDGE_QA_PAIRS = [
  {
    id: 'QA-1',
    question: 'How does an electronic Bill of Lading serve as valid collateral for trade finance?',
    answer: "The application records title issuance, holder consent and a pledge inside an explicitly enrolled registry domain. Real goods, enforceable security rights and disposal depend on the issuer, carrier, identity checks and the applicable business arrangements. The current instance uses simulated titles and test assets; registering a hash does not establish real-world collateral validity.",
    keywords: ['ebl', 'bill of lading', 'collateral', 'document of title', 'mletr', 'pledge', 'smart contract', 'enforcement'],
    source: "docs/architecture-current.md; docs/contracts.md; src/core/pricingEngine.js",
    searchQuery: 'eBL legal status document of title trade finance collateral',
    relatedKnowledgeIds: ['WAR-003', 'BUY-002']
  },

  {
    id: 'QA-2',
    question: "How are issue prices calculated and what do payout preferences mean?",
    answer: "One deterministic pricing engine produces every quote. It limits financing cost using declared or estimated profit, tenor, policy rates and collateral coverage, then validates final rounded terms. FAST, BALANCED and LOW_COST are research preferences rather than guaranteed payout speeds. Parameters are unvalidated, risk basis points are not default probabilities, and target redemption is not a promised return.",
    keywords: ['issue price', 'discount', 'payout speed', 'risk', 'base price', 'urgency', 'health score', 'evidence'],
    source: "docs/architecture-current.md; docs/contracts.md; src/core/pricingEngine.js",
    searchQuery: 'copper price drop Indian Ocean monsoon insurance expiry risk discount',
    relatedKnowledgeIds: ['COM-001', 'WEA-001', 'POR-001', 'WAR-001']
  },

  {
    id: 'QA-3',
    question: 'How does the AI Agent\'s output trigger on-chain contract actions? Is the AI itself on-chain?',
    answer: "AI and source analysis run off-chain. In Demo, the Agent simulates state transitions. In Live, it records analysis; participants sign controlled transaction plans in their wallets. RightsController checks title consent, valuation, roles, eligibility and terms, while RWAOfferingPoolV5 holds actual test tokens and distributes recovery. The old Oracle write and owner CLI are retired. Evidence commitments make versions verifiable, but do not prove source facts.",
    keywords: ['on-chain', 'contract action', 'risk oracle', 'off-chain', 'evidence hash', 'pricing event', 'state machine', 'transparency'],
    source: "docs/architecture-current.md; docs/contracts.md; src/core/pricingEngine.js",
    searchQuery: 'AI off-chain oracle on-chain pricing event evidence hash verification',
    relatedKnowledgeIds: []
  },

  {
    id: 'QA-4',
    question: 'What happens if the insurance expires while the cargo is still in transit? How does the AI protect investors?',
    answer: "Insurance expiry and other transport signals produce review recommendations. In Live, authorized participants decide and sign the controlled operations; the Agent does not automatically freeze funds or liquidate goods. Existing investors retain acquired refund and claim rights subject to the protocol state. Insurance coverage, actual recoveries and disposal evidence require independent verification.",
    keywords: ['insurance expiry', 'health factor', 'margin call', 'liquidation', 'cargo health', 'investor protection', 'evidence'],
    source: "docs/architecture-current.md; docs/contracts.md; src/core/pricingEngine.js",
    searchQuery: 'insurance expiry risk cargo in transit health factor margin call liquidation',
    relatedKnowledgeIds: ['WEA-001', 'POR-003', 'WAR-003']
  }
];

// ---- Helper functions ----

export function getAllQAPairs() {
  return JUDGE_QA_PAIRS;
}

export function getQAById(id) {
  return JUDGE_QA_PAIRS.find(p => p.id === id) || null;
}

/**
 * Search Q&A pairs by query keywords. Simulates RAG retrieval for judge Q&A.
 *
 * @param {string} query - The judge's question or keywords
 * @param {number} [limit=2] - Max pairs to return
 * @returns {Array<Object>} Matching Q&A pairs with scores
 */
export function searchQA(query, limit = 2) {
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) return [];

  const scored = JUDGE_QA_PAIRS.map(pair => {
    let score = 0;
    const answerLower = pair.answer.toLowerCase();
    const questionLower = pair.question.toLowerCase();
    const keywordsLower = pair.keywords.map(k => k.toLowerCase());

    for (const token of tokens) {
      if (keywordsLower.some(k => k === token)) score += 10;
      else if (keywordsLower.some(k => k.includes(token))) score += 6;
      else if (questionLower.includes(token)) score += 4;
      else if (answerLower.includes(token)) score += 2;
    }

    return { ...pair, _score: score };
  });

  return scored
    .filter(s => s._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}
