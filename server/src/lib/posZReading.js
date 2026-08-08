// Parser for the POS "Z READING" end-of-shift report, the document the Sales Order module's
// "Upload PDF" button ingests. One PDF = one shift at one branch = one row of the daily cash
// & collections grid.
//
// The report is a flat list of LABEL <amount> lines, with three nested blocks: the category
// breakdown under GROSS, the receivables aging under UNCOLLECTED, and REMAINING CREDIT at
// the end. Negative figures print in parentheses -- "DISCOUNT (0.00)".
//
// Mapping onto the grid columns, all taken as printed:
//
//   DATE                       <- CLOSED date
//   CASH                       <- CASH PAYMENT
//   GCASH                      <- OTHER PAYMENT
//   TOTAL DAILY SALES          <- NET SALES
//   TOTAL CASH TO BE DEPOSITED <- BANK DEPOSIT
//   TOTAL GCASH                <- OTHER PAYMENT
//   UNCOLLECTED SALES          <- UNCOLLECTED
//   VAT EX                     <- VATABLE SALES
//   VAT 12%                    <- VAT AMOUNT
//   VAT (INC.)                 <- NET SALES
//   COLLECTED BANK DEPOSIT     <- COLLECTED
//
// COLLECTED CASH and COLLECTED GCASH have no source in this document: the Z-Reading prints
// only the single COLLECTED total, not how those collections were tendered. They are left
// for the operator to split, and the split is checked to add back to COLLECTED.
//
// Everything is read rather than derived, then independently recomputed and compared -- an
// import whose own figures disagree is refused rather than stored, because a Z-Reading that
// does not balance means the document was misread, not that the till was wrong.

function num(v) {
  if (v === null || v === undefined) return null;
  const negative = /^\(.*\)$/.test(String(v).trim());
  const n = Number(String(v).replace(/[(),]/g, ''));
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}
function round2(n) { return Number(Number(n).toFixed(2)); }
function collapse(s) { return String(s).replace(/\s+/g, ' ').trim(); }

// Anchored at a line start so "COLLECTED" can never match the tail of "UNCOLLECTED", and
// tolerant of the amount having wrapped onto the following line.
function amountFor(text, label) {
  const re = new RegExp(`(?:^|\\n)[ \\t]*${label}[ \\t]*[\\s]*(\\(?-?[\\d,]+\\.\\d{2}\\)?)`, 'i');
  const m = re.exec(text);
  return m ? num(m[1]) : null;
}

function toIsoDate(mdY) {
  const [m, d, y] = mdY.split('/').map((p) => p.trim());
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  return `${year}-${String(Number(m)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
}
function to24h(time) {
  const m = /(\d{1,2}):(\d{2})\s*([AP])M/i.exec(time);
  if (!m) return null;
  let hour = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'P') hour += 12;
  return `${String(hour).padStart(2, '0')}:${m[2]}`;
}

const VAT_RATE = 12;
// Each stated figure is compared against one recomputed from the report's own other
// figures. A peso of slack absorbs the POS's own per-line rounding without letting a real
// discrepancy through.
const TOLERANCE = 0.01;

function parseZReading(rawText) {
  const text = String(rawText || '').replace(/\r/g, '');
  const errors = [];

  if (!/Z\s*[-]?\s*READING/i.test(text)) {
    return { ok: false, errors: ['This does not look like a Z READING report.'] };
  }

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const storeName = lines[0] || null;

  const counter = /Z-?COUNTER\s*:\s*([A-Z0-9]+)/i.exec(text);
  const shift = /SHIFT\s*:\s*([A-Z0-9 ]+)/i.exec(text);
  const opened = /OPENED:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s*@\s*([^\n]+)/i.exec(text);
  const closed = /CLOSED:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s*@\s*([^\n]+)/i.exec(text);
  const beginOr = /BEGINNING\s+OR#\s*:\s*(\S+)/i.exec(text);
  const endOr = /ENDING\s+OR#\s*:\s*(\S+)/i.exec(text);
  const tin = /VAT\s+REG\.?\s+TIN\s*:\s*([\d-]+)/i.exec(text);
  const serial = /(?:^|\n)\s*SN\s*:\s*(\S+)/i.exec(text);

  if (!closed) errors.push('Could not read the CLOSED date/time -- the shift date comes from it.');

  const f = {
    opening_drawer: amountFor(text, 'OPENING DRAWER AMOUNT'),
    closing_drawer: amountFor(text, 'CLOSING DRAWER AMOUNT'),
    void_transaction: amountFor(text, 'VOID TRANSACTION'),
    gross: amountFor(text, 'GROSS'),
    other_charges: amountFor(text, 'OTHER CHARGES'),
    discount: amountFor(text, 'DISCOUNT'),
    owner_account: amountFor(text, 'OWNER ACCOUNT'),
    net_sales: amountFor(text, 'NET SALES'),
    vatable_sales: amountFor(text, 'VATABLE SALES'),
    vat_amount: amountFor(text, 'VAT AMOUNT'),
    vat_exempt_sales: amountFor(text, 'VAT EXEMPT SALES'),
    zero_rated_sales: amountFor(text, 'ZERO RATED SALES'),
    cash_payment: amountFor(text, 'CASH PAYMENT'),
    credit_card: amountFor(text, 'CREDIT CARD'),
    debit_card: amountFor(text, 'DEBIT CARD'),
    other_payment: amountFor(text, 'OTHER PAYMENT'),
    collected: amountFor(text, 'COLLECTED'),
    uncollected: amountFor(text, 'UNCOLLECTED'),
    payins: amountFor(text, 'PAYINS'),
    payouts: amountFor(text, 'PAYOUTS'),
    cash_received: amountFor(text, 'CASH RECEIVED'),
    cash_count: amountFor(text, 'CASH COUNT'),
    excess: amountFor(text, 'EXCESS'),
    short: amountFor(text, 'SHORT'),
    bank_deposit: amountFor(text, 'BANK DEPOSIT'),
  };

  for (const required of ['gross', 'net_sales', 'vatable_sales', 'vat_amount', 'cash_payment', 'other_payment']) {
    if (f[required] === null) errors.push(`Could not read ${required.replace(/_/g, ' ').toUpperCase()} from the report.`);
  }

  // A name is whatever the report printed before the figures -- it is NOT restricted to a
  // guessed alphabet. An earlier version allowed only [A-Z0-9 &.'-/], and a real customer
  // called "FRESH AND TIDY ;;" silently failed to match: its 2,287.00 dropped out of the
  // aging list, the UNCOLLECTED total then disagreed with its own lines by exactly that
  // amount, and the whole shift was refused as unreadable. A cashier typing a stray
  // character must never cost a day's takings its import.
  //
  // The structure carries the match instead of the alphabet: a line qualifies by ending in
  // an amount (and, for the aging list, a date before it), which is what actually
  // distinguishes a data row from anything else inside these blocks.
  const NAME = String.raw`([^\n]*?\S)`;
  const AMOUNT = String.raw`(\(?-?[\d,]+\.\d{2}\)?)`;
  const EOL = String.raw`[ \t\r]*(?=\n|$)`;

  // Category breakdown: everything between the GROSS line and OTHER CHARGES.
  const categories = [];
  const grossIdx = text.search(/(?:^|\n)[ \t]*GROSS[ \t]/i);
  const otherChargesIdx = text.search(/(?:^|\n)[ \t]*OTHER CHARGES/i);
  if (grossIdx >= 0 && otherChargesIdx > grossIdx) {
    const block = text.slice(text.indexOf('\n', grossIdx + 1), otherChargesIdx);
    for (const m of block.matchAll(new RegExp(String.raw`(?:^|\n)[ \t]*${NAME}[ \t]+${AMOUNT}${EOL}`, 'g'))) {
      categories.push({ name: collapse(m[1]), amount: num(m[2]) });
    }
  }

  // Receivables aging under UNCOLLECTED: "<CUSTOMER> <MM/DD> <AMOUNT>", running to PAYINS.
  const uncollectedItems = [];
  const uncIdx = text.search(/(?:^|\n)[ \t]*UNCOLLECTED[ \t]/i);
  const payinsIdx = text.search(/(?:^|\n)[ \t]*PAYINS/i);
  if (uncIdx >= 0 && payinsIdx > uncIdx) {
    const block = text.slice(text.indexOf('\n', uncIdx + 1), payinsIdx);
    for (const m of block.matchAll(new RegExp(String.raw`(?:^|\n)[ \t]*${NAME}[ \t]+(\d{1,2}/\d{1,2})[ \t]+${AMOUNT}${EOL}`, 'g'))) {
      uncollectedItems.push({ customer: collapse(m[1]), reference_date: m[2], amount: num(m[3]) });
    }
  }

  // ---- verification: every figure the report states, recomputed from its own others ----
  const checks = [];
  function check(label, stated, computed, note) {
    if (stated === null || computed === null || !Number.isFinite(computed)) return;
    const ok = Math.abs(round2(stated) - round2(computed)) <= TOLERANCE;
    checks.push({ label, stated: round2(stated), computed: round2(computed), ok, note });
    if (!ok) errors.push(`${label}: report says ${round2(stated).toFixed(2)} but ${note} gives ${round2(computed).toFixed(2)}.`);
  }

  if (categories.length) {
    check('Gross', f.gross, categories.reduce((s, c) => s + (c.amount || 0), 0), 'its own category lines');
  }
  check('Net Sales', f.net_sales,
    (f.gross || 0) + (f.other_charges || 0) - Math.abs(f.discount || 0) - Math.abs(f.owner_account || 0),
    'gross + other charges - discount - owner account');
  check('Net Sales', f.net_sales,
    (f.cash_payment || 0) + (f.credit_card || 0) + (f.debit_card || 0) + (f.other_payment || 0),
    'the payment lines added up');
  check('Net Sales', f.net_sales,
    (f.vatable_sales || 0) + (f.vat_amount || 0) + (f.vat_exempt_sales || 0) + (f.zero_rated_sales || 0),
    'vatable + VAT + exempt + zero-rated');
  check('VAT Amount', f.vat_amount, (f.vatable_sales || 0) * (VAT_RATE / 100), `${VAT_RATE}% of vatable sales`);
  if (uncollectedItems.length) {
    check('Uncollected', f.uncollected, uncollectedItems.reduce((s, u) => s + (u.amount || 0), 0), 'its own aging lines');
  }
  if (f.cash_count !== null && f.opening_drawer !== null) {
    check('Cash Received', f.cash_received, f.cash_count - f.opening_drawer + (f.short || 0) - (f.excess || 0),
      'cash count less the opening drawer');
  }

  const closedDate = closed ? toIsoDate(closed[1]) : null;
  const closedTime = closed ? to24h(closed[2]) : null;
  const counterCode = counter ? counter[1] : null;
  const shiftName = shift ? collapse(shift[1]) : null;

  return {
    ok: errors.length === 0,
    errors,
    checks,
    store_name: storeName,
    tin: tin ? tin[1] : null,
    serial_no: serial ? serial[1] : null,
    branch_code: counterCode,
    shift: shiftName,
    opened_date: opened ? toIsoDate(opened[1]) : null,
    opened_time: opened ? to24h(opened[2]) : null,
    opened_by: opened ? collapse(opened[3]) : null,
    closed_date: closedDate,
    closed_time: closedTime,
    closed_by: closed ? collapse(closed[3]) : null,
    beginning_or: beginOr ? beginOr[1] : null,
    ending_or: endOr ? endOr[1] : null,
    figures: f,
    categories,
    uncollected_items: uncollectedItems,
    import_key: counterCode && closedDate ? `Z:${counterCode}/${shiftName}|${closedDate} ${closedTime || ''}`.trim() : null,

    // The grid row this shift becomes. collected_cash/collected_gcash start at 0 because the
    // report does not split its COLLECTED total by tender -- the operator fills those in and
    // the two are checked to add back to collected_bank_deposit on save.
    row: {
      sale_date: closedDate,
      cash: f.cash_payment,
      collected_cash: 0,
      gcash: f.other_payment,
      collected_gcash: 0,
      collected_bank_deposit: f.collected,
      total_daily_sales: f.net_sales,
      total_cash_to_deposit: f.bank_deposit,
      total_gcash: f.other_payment,
      uncollected_sales: f.uncollected,
      vat_ex: f.vatable_sales,
      vat_12: f.vat_amount,
      vat_inc: f.net_sales,
    },
  };
}

module.exports = { parseZReading };
