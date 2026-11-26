/**
 * 从「开单记录」跳到「开单」页时带过去的请求。
 *
 * 开单页是常驻挂载的（草稿、光标都要留着），不能用重挂载来传参，
 * 所以用一份带 `nonce` 的请求对象：`nonce` 一变就说明是新手势，
 * 同一次请求在页面重渲染时不会被重复执行。
 */
export interface VoucherRequest {
  nonce: number;
  id: number;
  /** edit = 载入编辑；convert = 抄成反向类型的新单；return = 从这张入库单退货 */
  action: "edit" | "convert" | "return";
}

let seq = 0;
export function nextVoucherRequest(id: number, action: VoucherRequest["action"]): VoucherRequest {
  seq += 1;
  return { nonce: seq, id, action };
}
