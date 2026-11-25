-- 015: 每个仓库自己的公司抬头
--
-- 打印单据时纸面上的公司名原来写死在 PrintVoucher 里。多仓之后每个仓可能
-- 对应不同主体（同一个老板的两家公司，或者代管的客户仓），所以放到仓库档案上，
-- 由「管理仓库」里逐仓填写。
--
-- 允许换行：有的抬头要带地址/电话，前端按 pre-line 渲染，不必再加列。
--
-- 升级默认值：这一版之前所有仓打出来的都是「温州乾力机械有限公司」，
-- 所以把已有仓库都填成同一行字，升级后先与之前一致，再由用户逐仓改。

ALTER TABLE warehouses ADD COLUMN company_name TEXT;

UPDATE warehouses
   SET company_name = '温州乾力机械有限公司'
 WHERE company_name IS NULL;
