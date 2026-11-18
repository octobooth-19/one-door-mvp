const reply = (text, suggestions = []) => ({ text, suggestions, calls: [] });

// A deterministic fixture driver, not an LLM. Production tool selection uses the model adapter.
export function createFinanceDemoPlanner({ asOf }) {
  return {
    id: 'demo',
    label: 'Rules-based preview',
    async choose({ message, context }) {
      const query = message.toLowerCase();
      if (/\b(show|see|load)\s+(me\s+)?(more|next)\b/.test(query)) {
        if (!context.nextCursor || context.lastTool !== 'finance_invoice_search') {
          return reply('There are no more invoices in the current search.', ['Show all my invoices']);
        }
        return {
          calls: [{
            name: 'finance_invoice_search',
            args: { ...context.lastArgs, cursor: context.nextCursor },
          }],
        };
      }
      if (/\b(terms?|methods?|remittance)\b/.test(query) || /\bhow\b.*\bpay\b/.test(query)) {
        return { calls: [{ name: 'finance_payment_terms', args: {} }] };
      }
      const invoice = message.toUpperCase().match(/\bINV-\d{4}\b/)?.[0] ??
        (query.match(/\binvoice\s+#?(\d{4})\b/)?.[1]
          ? `INV-${query.match(/\binvoice\s+#?(\d{4})\b/)[1]}` : undefined);
      if (!invoice && /\b(balance|outstanding|owe|overview|summary)\b/.test(query)) {
        return { calls: [{ name: 'finance_account_summary', args: {} }] };
      }
      const args = {};
      if (invoice) args.invoiceId = invoice;
      if (/\boverdue\b/.test(query)) args.status = 'overdue';
      else if (/\b(unpaid|not paid)\b/.test(query)) args.status = 'unpaid';
      else if (!invoice && /\bpaid\b/.test(query)) args.status = 'paid';
      else if (/\bopen\b/.test(query)) args.status = 'open';
      if (/\blast month\b/.test(query)) {
        const date = new Date(asOf);
        date.setUTCMonth(date.getUTCMonth() - 1, 1);
        args.month = date.toISOString().slice(0, 7);
      } else if (/\bthis month\b/.test(query)) {
        args.month = asOf.slice(0, 7);
      }
      if (!invoice && /\b(it|that one|that invoice)\b/.test(query)) {
        if (context.lastTool === 'finance_invoice_search' && context.lastArgs?.invoiceId) {
          args.invoiceId = context.lastArgs.invoiceId;
        } else {
          return reply('Which invoice would you like me to check?', ['Show all my invoices']);
        }
      }
      if (invoice || Object.keys(args).length || /\b(invoice|invoices|due|history|statement)\b/.test(query)) {
        return { calls: [{ name: 'finance_invoice_search', args }] };
      }
      return reply('Would you like to check an invoice, your account balance, or payment terms?',
        ['Show all my invoices', 'What is my outstanding balance?', 'What are our payment terms?']);
    },
  };
}
