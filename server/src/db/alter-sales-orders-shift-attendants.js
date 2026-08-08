// A Z-Reading names two people and stamps two times:
//
//   OPENED: 08/01/26 07:12 AM @ MaryRose
//   CLOSED: 08/01/26 05:43 PM @ CRISTY
//
// The import kept only the closer's name (sales_order_lines.pos_cashier) and neither time, so
// a shift that changed hands mid-day lost the fact and the reader could not tell when the till
// was actually open. Both names, both timestamps, and the employee each name resolves to are
// now kept on the line -- the line is the shift, and one order can collect several.
//
// The resolved employee ids are stored ALONGSIDE the printed names, never instead of them. A
// Z-Reading prints whatever the cashier typed at the terminal ("MaryRose", "CRISTY"), which may
// match no employee record at all; the printed name is what the document says and has to
// survive regardless of whether the lookup found anybody.
const pool = require('../db');

async function hasColumn(table, column) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return row.n > 0;
}

const LINE_COLUMNS = [
  ['pos_opened_by', 'VARCHAR(100) NULL'],
  ['pos_opened_at', 'DATETIME NULL'],
  ['pos_closed_at', 'DATETIME NULL'],
  // Nullable on purpose: an unmatched name is the normal case, not an error.
  ['pos_opened_employee_id', 'BIGINT NULL'],
  ['pos_closed_employee_id', 'BIGINT NULL'],
];

(async () => {
  try {
    for (const [col, def] of LINE_COLUMNS) {
      if (await hasColumn('sales_order_lines', col)) {
        console.log(`sales_order_lines.${col} already present -- skipped`);
      } else {
        await pool.query(`ALTER TABLE sales_order_lines ADD COLUMN ${col} ${def}`);
        console.log(`sales_order_lines.${col} added`);
      }
    }

    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
