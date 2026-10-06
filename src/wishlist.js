// 心愿单 —— 她自己的的"购物车"，独立于主人淘宝账号里的真实购物车
// 状态机: want(想要) → asked(已请示) → carted(已加购) → paid(已支付) → delivered(已送达)
//          任何非终态 → declined(被婉拒)；paid 之后由 check_gifts 对账

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.SHOPPING_DATA_DIR ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const WISH_FILE = path.join(DATA_DIR, 'wishlist.json');

export const STATUS = ['want', 'asked', 'carted', 'paid', 'delivered', 'declined'];

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(WISH_FILE, 'utf8'));
  } catch {
    cache = { nextId: 1, items: [] };
  }
  return cache;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(WISH_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

export function addWish({ itemId, title, price, image, url, reason, sku }) {
  const db = load();
  const w = {
    id: db.nextId++,
    itemId, title, price, image, url, sku,
    reason: reason || '',
    status: 'want',
    createdAt: new Date().toISOString(),
    askedAt: null, cartedAt: null, paidAt: null, deliveredAt: null,
    note: '',
  };
  db.items.push(w);
  save();
  return w;
}

export function getWish(id) {
  return load().items.find(w => w.id === Number(id)) || null;
}

export function setStatus(id, status, note = '') {
  const w = getWish(id);
  if (!w) throw new Error(`心愿 #${id} 不存在`);
  if (!STATUS.includes(status)) throw new Error(`非法状态 ${status}`);
  w.status = status;
  w.note = note || w.note;
  const t = { asked: 'askedAt', carted: 'cartedAt', paid: 'paidAt', delivered: 'deliveredAt' }[status];
  if (t) w[t] = new Date().toISOString();
  save();
  return w;
}

export function listWishes(status) {
  const items = load().items;
  return status ? items.filter(w => w.status === status) : items;
}

// 给主人看的待办清单：已请示未支付 + 已加购未支付
export function pendingForRin() {
  return load().items.filter(w => ['asked', 'carted'].includes(w.status));
}

export function monthStats() {
  const now = new Date();
  const m = now.toISOString().slice(0, 7);
  const inMonth = load().items.filter(w => w.createdAt.slice(0, 7) === m);
  return {
    month: m,
    added: inMonth.length,
    asked: inMonth.filter(w => w.status !== 'declined').length,
    estimatedTotal: inMonth
      .filter(w => ['asked', 'carted', 'paid', 'delivered'].includes(w.status))
      .reduce((s, w) => s + (Number(w.price) || 0), 0),
  };
}
