// Imported counter sales were the only document in the system posting to the ledger with no
// department against them: glImpact pushed department_id: null for every Z-Reading order, so
// their revenue and Undeposited Funds landed outside every department-scoped report while a
// Sales Invoice, Delivery Ticket or Vendor Bill covering the same money carried one.
//
// An estimate-derived order has never needed the column (its department is inferred from the
// sales division) and there is no honest value to backfill onto one, so the column is NULL at
// the schema level. The requirement lives on the import endpoint instead, which is the only
// path that can actually ask an operator which department the branch's takings belong to.
const pool = require('../db');

async function hasColumn(table, column) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return row.n > 0;
}

(async () => {
  try {
    if (await hasColumn('sales_orders', 'department_id')) {
      console.log('sales_orders.department_id already present -- skipped');
    } else {
      await pool.query('ALTER TABLE sales_orders ADD COLUMN department_id BIGINT NULL AFTER office_location_id');
      await pool.query('ALTER TABLE sales_orders ADD KEY idx_so_department (department_id)');
      console.log('sales_orders.department_id added');
    }

    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
