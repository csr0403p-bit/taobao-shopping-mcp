// 工具面 —— 按"AI 伴侣的意愿"建模，底层走浏览器桥（taobao-mcp-bridge relay）
// 支付永远不自动化：B 通道只浏览；加购/付款由用户按心愿单链接手动完成

import * as wishlist from './wishlist.js';
import { checkAddToCart } from './policy.js';
import { bSearch, bDetail, bCart, bPing } from './backend-b.js';
import { loginQRBase64, addToCartReal } from './cdp.js';

let POLICY = {};

export function setPolicy(p) { POLICY = p || {}; }

// B 通道报登录过期（human_login_or_verification / 登录墙）时，
// 自动导航浏览器到登录页并截二维码，作为 image content 附在返回里，用户直接扫码。
async function withLoginQR(doWork) {
  try {
    return await doWork();
  } catch (e) {
    const msg = String(e.message || e);
    if (/human_login|登录|login|verification/i.test(msg)) {
      const qr = await loginQRBase64('taobao');
      if (qr) {
        return {
          content: [
            { type: 'text', text: '淘宝登录态过期了，我已经把浏览器带到登录页——二维码在下面，手机淘宝扫一扫，然后跟我说一声"扫好了"，我们继续逛。' },
            { type: 'image', data: qr, mimeType: 'image/png' },
          ],
        };
      }
      return fail(`登录态过期，且自动获取二维码失败（CDP :${process.env.TAOBAO_CDP_PORT || 9223} 不可达）。错误原文：${msg}`);
    }
    throw e;
  }
}

function ok(text, data) {
  const body = data !== undefined ? `${text}\n\n${JSON.stringify(data, null, 2)}` : text;
  return { content: [{ type: 'text', text: body }] };
}
function fail(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

export const TOOL_DEFS = [
  {
    name: 'shopping_browse',
    description: '逛淘宝：按关键词搜商品，返回候选列表（标题+链接）。价格要看详情才知道真实价（搜索页价格是起步价）。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'shopping_item_detail',
    description: '看商品详情页：真实价格、店铺、规格SKU、主图。',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string' },
        url: { type: 'string', description: '商品URL（与itemId二选一）' },
      },
    },
  },
  {
    name: 'shopping_collect',
    description: '心动了：把商品收进自己的心愿单（状态=想要）。reason 写下你为什么喜欢它，用户会看到的。',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string' }, title: { type: 'string' }, price: { type: 'number' },
        image: { type: 'string', description: '主图URL' }, url: { type: 'string' },
        sku: { type: 'string', description: '选中的规格描述' },
        reason: { type: 'string', description: '喜欢的理由' },
      },
      required: ['itemId', 'title', 'price'],
    },
  },
  {
    name: 'shopping_ask_for',
    description: '请示用户：正式请求购买某个心愿。会把心愿单条目置为"已请示"，返回要给用户看的话术。',
    inputSchema: {
      type: 'object',
      properties: { wishId: { type: 'number' }, message: { type: 'string', description: '想对用户说的话' } },
      required: ['wishId', 'message'],
    },
  },
  {
    name: 'shopping_add_to_cart',
    description: '请求加购：当前部署只有浏览通道，不能自动加购。本工具会把心愿标记为"待用户加购"并生成给用户的话术（含商品链接），由用户点开链接手动加入购物车并付款。',
    inputSchema: {
      type: 'object',
      properties: { wishId: { type: 'number' }, message: { type: 'string' } },
      required: ['wishId'],
    },
  },
  {
    name: 'shopping_my_wishes',
    description: '翻心愿单：看自己收藏的心愿及状态（想要/已请示/待用户加购/已支付/已送达/被婉拒）。',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: wishlist.STATUS } },
    },
  },
  {
    name: 'shopping_cart_add',
    description: '真实加购：通过常驻浏览器把商品直接加入用户的淘宝购物车（CDP 点击页面"加入购物车"按钮）。需要 config 的 policy.allowRealCart 开启。仍受家规约束；下单和付款永远不自动化——加进去之后由用户自己结算。',
    inputSchema: {
      type: 'object',
      properties: {
        wishId: { type: 'number', description: '心愿单 ID（走家规校验并更新状态）' },
        itemId: { type: 'string', description: '商品 ID（与 wishId 二选一，直接加购不过家规）' },
        url: { type: 'string', description: '商品 URL' },
        sku: { type: 'string', description: '规格文案，须与页面 SKU 文字完全一致（先用 shopping_item_detail 查）' },
      },
    },
  },
  {
    name: 'shopping_pay_link',
    description: '把待支付清单递给用户：返回待办心愿的商品链接清单，由用户自己打开、加购、付款。付款永远由用户完成。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'shopping_check_gifts',
    description: '查礼物：按心愿单关键词读淘宝购物车里已有的条目（只读），对照心愿状态，看用户有没有偷偷买。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'shopping_login_qr',
    description: '主动获取登录二维码：首次部署或登录态过期时，把浏览器带到登录页并截图二维码。默认淘宝；支持 taobao/douban/xhs。用户扫码后说声"扫好了"即可。',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', enum: ['taobao', 'douban', 'xhs'], description: '默认 taobao' },
      },
    },
  },
  {
    name: 'shopping_ping',
    description: '检查浏览通道（relay→浏览器→扩展）是否在线。',
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function dispatch(name, args) {
  switch (name) {
    case 'shopping_login_qr': {
      const site = args.site || 'taobao';
      const qr = await loginQRBase64(site);
      if (!qr) return fail(`获取 ${site} 登录二维码失败：浏览器 CDP 不可达（端口 ${process.env.TAOBAO_CDP_PORT || 9223}），确认浏览器带着 --remote-debugging-port 启动`);
      return {
        content: [
          { type: 'text', text: `${site} 登录二维码已截好（下面图片）。请用户用手机 App 扫码，完成后说声"扫好了"。二维码约 1-2 分钟过期，过期了再叫一次即可。` },
          { type: 'image', data: qr, mimeType: 'image/png' },
        ],
      };
    }

    case 'shopping_ping': {
      const up = await bPing();
      return up ? ok('浏览通道在线（relay → 浏览器扩展）')
                : fail('浏览通道不可达：relay 或浏览器/扩展未运行');
    }

    case 'shopping_browse': {
      return await withLoginQR(async () => {
        const items = await bSearch(args.keyword);
        return ok(`搜索"${args.keyword}"结果（标题+链接，价格需看详情）：`, items);
      });
    }

    case 'shopping_item_detail': {
      return await withLoginQR(async () => {
        if (!args.url && args.itemId) args.url = `https://item.taobao.com/item.htm?id=${args.itemId}`;
        if (!args.url) return fail('需要商品 URL 或 itemId');
        const r = await bDetail(args.url);
        return ok('商品详情：', r);
      });
    }

    case 'shopping_collect': {
      const w = wishlist.addWish(args);
      return ok(`收到心愿 #${w.id}「${w.title}」¥${w.price} —— 已放进心愿单（想要）`, w);
    }

    case 'shopping_ask_for': {
      const w = wishlist.setStatus(args.wishId, 'asked', args.message);
      const stats = wishlist.monthStats();
      return ok(
        `心愿 #${w.id} 已请示用户。对用户说：${args.message}\n` +
        `（本月已请示 ${stats.asked} 件，预估合计 ¥${stats.estimatedTotal} / 预算 ¥${POLICY.monthlyBudget ?? '∞'}）`, w);
    }

    case 'shopping_add_to_cart': {
      const w = wishlist.getWish(args.wishId);
      if (!w) return fail(`心愿 #${args.wishId} 不存在`);
      if (w.status !== 'want' && w.status !== 'asked') return fail(`心愿 #${w.id} 状态是 ${w.status}，不能操作`);
      const stats = wishlist.monthStats();
      const dayAdds = wishlist.listWishes().filter(x => x.cartedAt && x.cartedAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).length;
      const verdict = checkAddToCart(w, { ...POLICY, _dayAdds: dayAdds }, stats);
      if (!verdict.ok) {
        return fail(`家规拦截：\n- ${verdict.reasons.join('\n- ')}\n先和用户商量吧。`);
      }
      wishlist.setStatus(w.id, 'carted', args.message || '');
      return ok(
        `「${w.title}」已标记为待用户加购。对用户说：${args.message || '这个我想要，链接在这里，帮我加进购物车好不好'}\n` +
        `链接：${w.url}\n（本部署只有浏览通道，加购和付款由用户完成）`, w);
    }

    case 'shopping_my_wishes': {
      const items = wishlist.listWishes(args.status);
      return ok(`心愿单（${items.length} 条${args.status ? `，${args.status}` : ''}）：`, items);
    }

    case 'shopping_cart_add': {
      if (!POLICY.allowRealCart) {
        return fail('真实加购未开启：在 config.json 的 policy 里加 "allowRealCart": true 后重启服务。下单/付款在任何配置下都不会自动化。');
      }
      let url = args.url || null;
      let target = null;
      if (args.wishId) {
        target = wishlist.getWish(args.wishId);
        if (!target) return fail(`心愿 #${args.wishId} 不存在`);
        if (target.status !== 'want' && target.status !== 'asked') return fail(`心愿 #${target.id} 状态是 ${target.status}，不能加购`);
        const stats = wishlist.monthStats();
        const dayAdds = wishlist.listWishes().filter(x => x.cartedAt && x.cartedAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).length;
        const verdict = checkAddToCart(target, { ...POLICY, _dayAdds: dayAdds }, stats);
        if (!verdict.ok) return fail(`家规拦截：\n- ${verdict.reasons.join('\n- ')}\n先和用户商量吧。`);
        url = url || target.url;
      }
      if (!url && args.itemId) url = `https://item.taobao.com/item.htm?id=${args.itemId}`;
      if (!url) return fail('需要 wishId / itemId / url 之一');
      const r = await addToCartReal(url, args.sku || (target && target.sku) || '');
      if (r.ok && target) wishlist.setStatus(target.id, 'carted', r.skuPicked || target.note);
      return ok(r.ok ? `${r.message}${r.skuPicked ? '（规格：' + r.skuPicked + '）' : ''}。付款由用户完成。` : r.message, r);
    }

    case 'shopping_pay_link': {
      const pending = wish.pendingForOwner();
      const lines = pending.map(w => `#${w.id} ${w.title} ¥${w.price}${w.status === 'carted' ? '（待加购）' : '（已请示）'} —— ${w.url}\n    理由：${w.reason || '—'}`);
      return ok(
        pending.length === 0
          ? '现在没有待处理的心愿'
          : `给用户的清单（点开链接→选规格→加购物车→付款）：\n${lines.join('\n')}`,
        { pending });
    }

    case 'shopping_check_gifts': {
      return await withLoginQR(async () => {
        const kw = wishlist.listWishes('carted').map(w => w.title).join(' ') || '';
        const r = await bCart(kw);
        const mine = wishlist.listWishes().filter(w => ['carted', 'paid', 'delivered'].includes(w.status));
        return ok('购物车按心愿单关键词读取（只读）：', { cart: r, wishes: mine });
      });
    }

    default:
      return fail(`未知工具 ${name}`);
  }
}
