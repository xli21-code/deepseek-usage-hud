'use strict';
// Formatting money, driven by the currency the API reports.
//
// `/user/balance` returns a `currency` code per balance entry, so the symbol
// has to follow it. Accounts are not all CNY — the same API is sold in USD on
// the global platform — and a hardcoded ¥ renders a dollar balance as
// "¥42.10 USD", which is both wrong and confusing about magnitude.
//
// A code with no entry here falls back to the bare number plus the code. That
// is deliberate: inventing a symbol for an unknown currency is worse than
// showing none, and the code is always carried as a suffix anyway.

const SYMBOLS = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: 'JP¥', // deliberately distinct from CNY's ¥
  KRW: '₩',
  INR: '₹',
  RUB: '₽',
  BRL: 'R$',
  HKD: 'HK$',
  TWD: 'NT$',
  SGD: 'S$',
  AUD: 'A$',
  CAD: 'C$',
};

function symbolFor(currency) {
  const code = String(currency ?? '').trim().toUpperCase();
  return SYMBOLS[code] || '';
}

/** `formatAmount(42.1, 'USD')` → `"$42.10 USD"`; unknown code → `"42.10 XYZ"`. */
function formatAmount(amount, currency) {
  const n = Number(amount);
  const num = Number.isFinite(n) ? n.toFixed(2) : String(amount);
  const code = String(currency ?? '').trim().toUpperCase();
  const symbol = symbolFor(code);
  const head = symbol ? `${symbol}${num}` : num;
  return code ? `${head} ${code}` : head;
}

module.exports = { formatAmount, symbolFor, SYMBOLS };
