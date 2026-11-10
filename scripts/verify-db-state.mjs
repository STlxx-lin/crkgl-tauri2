// 在真实数据库上验证批量改/删的落库效果（不经过 UI）。
// 直接对 SQLite 做等价操作，确认字段与行数口径一致。
import { execFileSync } from "node:child_process";

const py = `
import os, sqlite3, json
p = os.path.expandvars(r'%APPDATA%\\coldcoffee.warehouse.ledger\\ledger.db')
c = sqlite3.connect(p)
c.row_factory = sqlite3.Row

out = {}
out['ledger_total'] = c.execute('SELECT COUNT(*) FROM ledger').fetchone()[0]
out['vouchers'] = c.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0]
out['with_voucher_id'] = c.execute('SELECT COUNT(*) FROM ledger WHERE voucher_id IS NOT NULL').fetchone()[0]
out['owners_distinct'] = c.execute("SELECT COUNT(DISTINCT owner) FROM ledger WHERE TRIM(COALESCE(owner,''))<>''").fetchone()[0]
print(json.dumps(out, ensure_ascii=False, indent=2))
c.close()
`;

console.log(execFileSync("python", ["-I", "-c", py], { encoding: "utf8" }));
