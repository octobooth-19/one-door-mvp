import { readFile } from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import { canonical, freeze, parseJson, requireThat, safeEqual } from '../lib/shared.mjs';
import { object, resultSchema, text } from '../lib/schema.mjs';

export const FINANCE_AUDIENCE = 'urn:one-door:connector:finance';
export const financeTools = freeze([
  {
    name: 'finance_account_summary',
    title: 'Account balance',
    description: 'Read the current customer account balance, overdue amount, and invoice counts. Never changes payments or records.',
    inputSchema: object({}),
    outputSchema: resultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'finance_invoice_search',
    title: 'Invoice lookup',
    description: 'Read this customer account invoices. Filter by invoiceId, status, or issue month. Use nextCursor only with the original filters. Returns at most 10 records; no changes.',
    inputSchema: object({
      invoiceId: { ...text(8), pattern: '^INV-[0-9]{4}$' },
      status: { type: 'string', enum: ['all', 'open', 'overdue', 'paid', 'unpaid'] },
      month: { ...text(7), pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
      cursor: text(2048),
    }, []),
    outputSchema: resultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'finance_payment_terms',
    title: 'Payment terms',
    description: 'Read the customer account payment terms and supported payment methods. This cannot make a payment, refund, or change bank details.',
    inputSchema: object({}),
    outputSchema: resultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
]);

const money = value => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 2,
}).format(value);
const columns = [
  { key: 'invoice', label: 'Invoice', format: 'text' },
  { key: 'status', label: 'Status', format: 'status' },
  { key: 'due', label: 'Due date', format: 'date' },
  { key: 'balance', label: 'Balance', format: 'money' },
];
const row = invoice => ({
  invoice: invoice.id, status: invoice.status, due: invoice.due, balance: invoice.balance,
});

export async function createFinanceConnector({ now = Date.now, dataset } = {}) {
  const data = dataset ?? JSON.parse(await readFile(new URL('./finance-data.json', import.meta.url), 'utf8'));
  const cursorKey = randomBytes(32);

  function cursorFor(principal, filters, offset) {
    const body = Buffer.from(canonical({
      principal: principal.id, organization: principal.organizationId,
      filters, offset, expiresAt: now() + 300_000,
    })).toString('base64url');
    return `${body}.${createHmac('sha256', cursorKey).update(body).digest('base64url')}`;
  }

  function readCursor(cursor, principal, filters) {
    const parts = cursor.split('.');
    const [body, signature] = parts;
    requireThat(parts.length === 2 && safeEqual(signature,
      createHmac('sha256', cursorKey).update(body).digest('base64url')),
    'INVALID_CURSOR', 'The page reference is invalid. Run the original search again.');
    const decoded = parseJson(Buffer.from(body, 'base64url').toString('utf8'), 'INVALID_CURSOR');
    requireThat(decoded.principal === principal.id &&
      decoded.organization === principal.organizationId && decoded.expiresAt > now() &&
      canonical(decoded.filters) === canonical(filters) &&
      Number.isSafeInteger(decoded.offset) && decoded.offset >= 0,
    'INVALID_CURSOR', 'This page reference is expired or belongs to a different search.');
    return decoded.offset;
  }

  async function execute(name, args, principal) {
    requireThat(principal.scopes.includes('finance:read'), 'ACCESS_DENIED',
      'Finance is not available to this account.', 403);
    const account = data.accounts[principal.organizationId];
    requireThat(account, 'ACCESS_DENIED', 'Finance is not available to this account.', 403);
    const base = {
      title: '', summary: '', asOf: data.asOf, metrics: [], columns: [], rows: [],
      details: [], suggestions: [], nextCursor: null,
    };
    if (name === 'finance_account_summary') {
      const outstanding = account.invoices.reduce((sum, invoice) => sum + invoice.balance, 0);
      const overdue = account.invoices.filter(invoice => invoice.status === 'Overdue');
      const openCount = account.invoices.filter(invoice => invoice.balance > 0).length;
      const overdueAmount = overdue.reduce((sum, invoice) => sum + invoice.balance, 0);
      return {
        ...base, title: 'Your account, at a glance',
        summary: `${account.name} has ${money(outstanding)} outstanding across ${openCount} unpaid invoice${openCount === 1 ? '' : 's'}.${overdue.length ? ` ${money(overdueAmount)} is overdue.` : ' None are overdue.'}`,
        metrics: [
          { label: 'Outstanding', value: money(outstanding), tone: 'neutral' },
          { label: 'Overdue', value: money(overdueAmount), tone: overdueAmount ? 'warning' : 'positive' },
          { label: 'Unpaid invoices', value: String(openCount), tone: 'neutral' },
        ],
        columns, rows: account.invoices.filter(invoice => invoice.balance > 0).slice(0, 10).map(row),
        suggestions: ['Show all my invoices', 'What are our payment terms?'],
      };
    }
    if (name === 'finance_payment_terms') {
      return {
        ...base, title: 'Payment terms, without the fine print',
        summary: `${account.name} is on ${account.terms} payment terms. You can pay by bank transfer or through the customer billing portal. No payment is made from this chat.`,
        details: [
          { label: 'Payment terms', value: account.terms },
          { label: 'Accepted methods', value: account.methods },
          { label: 'Payment reference', value: account.reference },
          { label: 'Data notice', value: 'Illustrative terms for a synthetic account. No real bank details are stored.' },
        ],
        suggestions: ['What is my outstanding balance?', 'Show my overdue invoices'],
      };
    }
    requireThat(name === 'finance_invoice_search', 'TOOL_DENIED',
      'This connector exposes read-only Finance tools only.', 403);
    const { cursor, ...filters } = args;
    const offset = cursor ? readCursor(cursor, principal, filters) : 0;
    let invoices = account.invoices;
    if (args.invoiceId) {
      invoices = invoices.filter(invoice => invoice.id === args.invoiceId);
      requireThat(invoices.length > 0, 'NOT_FOUND',
        'That invoice is not available to this account. Check the invoice number and try again.', 404);
    }
    if (args.status && args.status !== 'all') {
      invoices = invoices.filter(invoice => args.status === 'unpaid'
        ? invoice.balance > 0 : invoice.status.toLowerCase() === args.status);
    }
    if (args.month) invoices = invoices.filter(invoice => invoice.issued.startsWith(args.month));
    const limit = args.limit ?? 5;
    const page = invoices.slice(offset, offset + limit);
    const single = args.invoiceId && page.length === 1 ? page[0] : null;
    const summary = single
      ? `${single.id} is ${single.status.toLowerCase()}. The remaining balance is ${money(single.balance)}${single.balance ? `, due ${single.due}` : ''}.`
      : invoices.length
        ? `Found ${invoices.length} matching invoice${invoices.length === 1 ? '' : 's'} for ${account.name}. Showing ${offset + 1}-${offset + page.length}.`
        : `There are no matching invoices for ${account.name}.`;
    return {
      ...base,
      title: single ? `Invoice ${single.id}` : args.status === 'overdue' ? 'Invoices that need attention' : 'Your invoices',
      summary, columns, rows: page.map(row),
      details: single ? [
        { label: 'Description', value: single.description },
        { label: 'Issued', value: single.issued },
        { label: 'Invoice total', value: money(single.total) },
      ] : [],
      suggestions: ['What is my outstanding balance?', 'What are our payment terms?'],
      nextCursor: offset + limit < invoices.length ? cursorFor(principal, filters, offset + limit) : null,
    };
  }

  return {
    id: 'finance', name: 'Finance sample connector', version: '0.1.0',
    tools: financeTools, execute, asOf: data.asOf,
    canRead: principal => principal.scopes.includes('finance:read'),
  };
}
