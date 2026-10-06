// 家规层 —— 硬约束，工具层直接拒绝，不依赖提示词自觉
// 配置来自 config.json 的 policy 字段

export function checkAddToCart(wish, policy, monthStats) {
  const { perItemAskLimit = 200, monthlyBudget = 1000, maxAddsPerDay = 5 } = policy || {};
  const reasons = [];

  const price = Number(wish.price) || 0;
  if (price > perItemAskLimit && wish.status !== 'asked') {
    reasons.push(`单价 ¥${price} 超过免请示上限 ¥${perItemAskLimit}，必须先请示用户同意（status=asked）后才能加购`);
  }
  if (price > 0 && monthStats.estimatedTotal + price > monthlyBudget) {
    reasons.push(`本月预估 ¥${(monthStats.estimatedTotal + price).toFixed(2)} 将超出月度预算 ¥${monthlyBudget}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  // dayAdds 由调用方从 wishlist 统计后传入
  if (policy?._dayAdds >= maxAddsPerDay) {
    reasons.push(`今日已加购 ${policy._dayAdds} 件，达到每日上限 ${maxAddsPerDay}`);
  }
  return { ok: reasons.length === 0, reasons };
}
