// 端到端：通过真实数据库验证开单与批量操作的落库效果。
// 用只读站 API 只读不写，所以这里直接对 SQLite 做断言。
import { execFileSync } from "node:child_process";

const py = String.raw`
import os, sqlite3, json
p = os.path.expandvars(r'%APPDATA%\coldcoffee.warehouse.ledger\ledger.db')
c = sqlite3.connect(p)
c.row_factory = sqlite3.Row

def q(sql, *args):
    return [dict(r) for r in c.execute(sql, args).fetchall()]

print(json.dumps({
  'schema': q('PRAGMA user_version')[0],
  'voucher_table': q("SELECT name FROM sqlite_master WHERE name='vouchers'"),
  'ledger_has_voucher_id': [r['name'] for r in q('PRAGMA table_info(ledger)') if r['name']=='voucher_id'],
  'voucher_rows': q('SELECT COUNT(*) n FROM vouchers')[0]['n'],
  'ledger_total': q('SELECT COUNT(*) n FROM ledger')[0]['n'],
}, ensure_ascii=False, indent=2))
c.close()
`;

const out = execFileSync("python", ["-I", "-c", py], { encoding: "utf8" });
console.log(out);
