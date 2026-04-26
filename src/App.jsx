
import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";

const ADMIN_EMAIL = "qzwxec88888@gmail.com";
import * as XLSX from "xlsx";
import "./App.css";

const PRICE_RANGES = [
  "전체", "0~5000", "5000~10000", "10000~15000", "15000~20000",
  "20000~25000", "25000~30000", "30000~35000", "35000+",
];

const TABS = ["대시보드", "재고관리", "수동박스", "랜덤스쿱", "주문관리", "취소보관함", "설정"];

function nowString() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function toNum(v) {
  if (v === null || v === undefined || v === "") return 0;
  const cleaned = String(v).replaceAll(",", "").replaceAll("원", "").replaceAll("%", "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function toInt(v) {
  return Math.round(toNum(v));
}

function money(v) {
  return `${toInt(v).toLocaleString()}원`;
}

function normalizeColName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[ \t\n\r()[\]{}_\-·./]/g, "");
}

function splitMultiValues(value) {
  if (!value) return [];
  let s = String(value).trim();
  ["\n", "\r", "/", "\\", ",", "，", "、", "·", "ㆍ", "|", "&", "+"].forEach((sep) => {
    s = s.replaceAll(sep, ",");
  });
  const out = [];
  s.split(",").forEach((v) => {
    const t = v.trim().replace(/\s+/g, " ");
    if (t && !out.includes(t)) out.push(t);
  });
  return out;
}

function valueMatchesSelected(value, selected) {
  if (!selected || selected.length === 0) return true;
  const tokens = splitMultiValues(value);
  return selected.some((v) => tokens.includes(v));
}

function inPriceRange(value, label) {
  const price = toNum(value);
  if (label === "전체") return true;
  if (label.endsWith("+")) return price >= Number(label.replace("+", ""));
  const [min, max] = label.split("~").map(Number);
  return price >= min && price < max;
}

function calcFinance(items, salePrice, feeRate) {
  const wholesaleSum = items.reduce((sum, p) => sum + toInt(p.wholesale), 0);
  const retailSum = items.reduce((sum, p) => sum + toInt(p.retail), 0);
  const sale = toInt(salePrice);
  const feeAmount = Math.round((sale * Number(feeRate || 0)) / 100);
  const netAmount = sale - feeAmount;
  const profit = netAmount - wholesaleSum;
  const margin = sale > 0 ? (profit / sale) * 100 : 0;
  return { wholesaleSum, retailSum, feeAmount, netAmount, profit, margin };
}

function pickCol(row, names) {
  const keys = Object.keys(row || {});
  const direct = {};
  const norm = {};
  keys.forEach((k) => {
    direct[String(k).trim()] = k;
    norm[normalizeColName(k)] = k;
  });
  for (const name of names) {
    if (direct[name]) return row[direct[name]];
    const nk = normalizeColName(name);
    if (norm[nk]) return row[norm[nk]];
  }
  return "";
}


function buildRecommendationCheck({ type, saleTotal, retailTarget, bodyRetailSum, totalRetailSum, margin, minMargin, maxMargin, giftName, zeroStockNames = [] }) {
  const checks = [];
  const retailOk = bodyRetailSum >= retailTarget;
  const marginOk = margin >= minMargin && margin <= maxMargin;
  const giftOk = type !== "소확행" || !!giftName;

  checks.push(retailOk ? "✅ 소비자가 조건 통과" : "❌ 소비자가 부족");
  checks.push(marginOk ? "✅ 마진 조건 통과" : "❌ 마진 범위 밖");
  if (type === "소확행") checks.push(giftOk ? "🎁 랜덤선물 포함" : "❌ 랜덤선물 없음");
  if (zeroStockNames.length > 0) checks.push(`⚠️ 마지막 재고 포함 ${zeroStockNames.length}개`);
  else checks.push("✅ 마지막 재고 없음");

  return checks.join(" / ");
}

function productFromExcelRow(row) {
  const name = pickCol(row, ["상품명", "상품 이름", "제품명", "품명", "name"]);
  let retail = pickCol(row, ["개별가격", "소비자가", "판매가", "정가", "retail"]);
  if (!retail && name) {
    const m = String(name).match(/^\s*(\d+)/);
    if (m) retail = m[1];
  }
  return {
    name: String(name || "").trim(),
    char1: String(pickCol(row, ["캐릭터(1)", "캐릭터1", "캐릭터 1", "캐릭터①", "캐릭터대분류", "대분류캐릭터", "대표캐릭터", "브랜드", "char1"]) || "").trim(),
    char2: String(pickCol(row, ["캐릭터(2)", "캐릭터2", "캐릭터 2", "캐릭터②", "캐릭터소분류", "소분류캐릭터", "세부캐릭터", "상세캐릭터", "캐릭터명", "캐릭터", "char2"]) || "").trim(),
    category: String(pickCol(row, ["카테고리", "분류", "category"]) || "").trim(),
    stock: toInt(pickCol(row, ["현재재고", "재고", "수량", "stock"])),
    wholesale: toInt(pickCol(row, ["도매가", "원가", "매입가", "wholesale"])),
    retail: toInt(retail),
    hidden: false,
  };
}

function scoreProductForStyle(p, style) {
  const r = toInt(p.retail);
  if (style === "자잘자잘") return 100000 - r;
  if (style === "큼직큼직") return r;
  if (style === "믹스") return 50000 - Math.abs(r - 12000);
  return Math.random() * 1000;
}


function isGiftCandidate(p) {
  const name = String(p.name || "");
  const cat = String(p.category || "");
  const r = toInt(p.retail);
  return (
    name.includes("소확행") ||
    name.includes("랜덤선물") ||
    cat.includes("소확행") ||
    cat.includes("선물") ||
    (r >= 3000 && r <= 6000)
  );
}

function isWithinMargin(fin, targetMargin) {
  const min = Number(targetMargin || 0);
  const max = min + 5;
  return fin.margin >= min && fin.margin <= max;
}

function retailSumOf(items) {
  return items.reduce((s, p) => s + toInt(p.retail), 0);
}

function bodyItemsOf(items) {
  return items.filter((p) => p._tag !== "랜덤선물");
}

function findClosestRetailProduct(pool, gap, usedIds = new Set()) {
  return pool
    .filter((p) => !usedIds.has(p.id))
    .sort((a, b) => Math.abs(toInt(a.retail) - gap) - Math.abs(toInt(b.retail) - gap))[0];
}

function productCharacters(p) {
  return [...splitMultiValues(p.char1), ...splitMultiValues(p.char2)].filter(Boolean);
}

function hasSharedCharacter(a, b) {
  const aa = new Set(Array.isArray(a) ? a : productCharacters(a));
  const bb = Array.isArray(b) ? b : productCharacters(b);
  return Array.from(bb).some((x) => aa.has(x));
}


function productCharacters(p) {
  return [...splitMultiValues(p.char1), ...splitMultiValues(p.char2)].filter(Boolean);
}

function productMatchesPreferredChars(p, pref1, pref2) {
  const chars = productCharacters(p);
  const c1Ok = !pref1?.length || splitMultiValues(p.char1).some((x) => pref1.includes(x));
  const c2Ok = !pref2?.length || splitMultiValues(p.char2).some((x) => pref2.includes(x));
  return c1Ok && c2Ok;
}

function hasSharedCharacter(charList, p) {
  const set = new Set(charList || []);
  return productCharacters(p).some((c) => set.has(c));
}

function compactText(v, max = 42) {
  const s = String(v || "");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function MultiCheckFilter({ label, options, selected, setSelected }) {
  const [open, setOpen] = useState(false);
  const [kw, setKw] = useState("");

  const shown = options.filter((v) => v !== "전체" && (!kw.trim() || v.toLowerCase().includes(kw.trim().toLowerCase())));
  const text = selected.length === 0 ? `${label}: 전체` : selected.length === 1 ? `${label}: ${selected[0]}` : `${label}: ${selected.length}개 선택`;

  function toggle(v) {
    setSelected(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  }

  function selectShown() {
    setSelected(Array.from(new Set([...selected, ...shown])));
  }

  function clearShown() {
    setSelected(selected.filter((x) => !shown.includes(x)));
  }

  return (
    <>
      <button type="button" className="multiBtn" onClick={() => setOpen(true)} title={selected.length ? selected.join(", ") : "전체"}>
        {text}
      </button>

      {open && (
        <div className="modalOverlay">
          <div className="multiModal">
            <div className="modalTitle">
              <strong>{label} 선택 ({options.filter((v) => v !== "전체").length}개)</strong>
              <button type="button" className="closeBtn" onClick={() => setOpen(false)}>닫기</button>
            </div>

            <div className="modalSearchRow">
              <label>검색</label>
              <input value={kw} onChange={(e) => setKw(e.target.value)} placeholder={`${label} 검색`} autoFocus />
            </div>

            <div className="selectedPreview">
              {selected.length === 0 ? "선택: 전체" : "선택: " + selected.join(", ")}
            </div>

            <div className="multiActions">
              <button type="button" onClick={selectShown}>현재 검색 전체선택</button>
              <button type="button" onClick={clearShown}>현재 검색 해제</button>
              <button type="button" onClick={() => setSelected([])}>전체 해제</button>
            </div>

            <div className="modalCheckList">
              {shown.map((v) => (
                <label key={v} className="modalCheckItem">
                  <input type="checkbox" checked={selected.includes(v)} onChange={() => toggle(v)} />
                  <span>{v}</span>
                </label>
              ))}
              {shown.length === 0 && <div className="emptySmall">목록 없음</div>}
            </div>

            <div className="modalBottom">
              <button type="button" onClick={() => setOpen(false)}>적용</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState("대시보드");

  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");

  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [orderItems, setOrderItems] = useState([]);
  const [materials, setMaterials] = useState([]);

  const [selectedProductId, setSelectedProductId] = useState(null);
  const [selectedOrderId, setSelectedOrderId] = useState(null);
  const [selectedMaterialId, setSelectedMaterialId] = useState(null);
  const [isShipping, setIsShipping] = useState(false);
  const [isImportingExcel, setIsImportingExcel] = useState(false);

  const [search, setSearch] = useState("");
  const [char1Selected, setChar1Selected] = useState([]);
  const [char2Selected, setChar2Selected] = useState([]);
  const [categoryFilter, setCategoryFilter] = useState("전체");
  const [priceFilter, setPriceFilter] = useState("전체");
  const [hiddenOnly, setHiddenOnly] = useState(false);
  const [excludeLowStock, setExcludeLowStock] = useState(false);
  const [productSort, setProductSort] = useState("기본순");

  const [composeItems, setComposeItems] = useState([]);
  const [salePrice, setSalePrice] = useState("39900");
  const [feeRate, setFeeRate] = useState("3.63");
  const [defaultSale, setDefaultSale] = useState("39900");
  const [defaultFee, setDefaultFee] = useState("3.63");
  const [customer, setCustomer] = useState("");
  const [memo, setMemo] = useState("");
  const [reorder, setReorder] = useState(false);

  const [materialName, setMaterialName] = useState("");
  const [materialAmount, setMaterialAmount] = useState("");

  const [orderSearchCustomer, setOrderSearchCustomer] = useState("");
  const [orderSearchDate, setOrderSearchDate] = useState("");
  const [orderReorderOnly, setOrderReorderOnly] = useState(false);

  const [productForm, setProductForm] = useState({
    name: "", char1: "", char2: "", category: "", stock: "", wholesale: "", retail: "", hidden: false,
  });

  const [manualType, setManualType] = useState("프리미엄박스");
  const [manualBoxCount, setManualBoxCount] = useState("1");
  const [manualTargetMargin, setManualTargetMargin] = useState("20");
  const [manualRetailExtra, setManualRetailExtra] = useState("0");
  const [manualHiddenDiscount, setManualHiddenDiscount] = useState("5");
  const [manualStyle, setManualStyle] = useState("선택안함");
  const [manualPrefChar1, setManualPrefChar1] = useState([]);
  const [manualPrefChar2, setManualPrefChar2] = useState([]);
  const [manualRecommendations, setManualRecommendations] = useState([]);
  const [selectedManualIndex, setSelectedManualIndex] = useState(null);
  const [manualCustomer, setManualCustomer] = useState("");
  const [manualMemo, setManualMemo] = useState("");
  const [manualReorder, setManualReorder] = useState(false);

  const [scoopGroupCount, setScoopGroupCount] = useState("6");
  const [scoopMode, setScoopMode] = useState("상품 수 균등");
  const [scoopPrice, setScoopPrice] = useState("전체");
  const [scoopRetailLimit, setScoopRetailLimit] = useState("");
  const [scoopChar1Selected, setScoopChar1Selected] = useState([]);
  const [scoopChar2Selected, setScoopChar2Selected] = useState([]);
  const [scoopGroups, setScoopGroups] = useState([]);
  const [scoopRecommendations, setScoopRecommendations] = useState([]);
  const [selectedScoopIndex, setSelectedScoopIndex] = useState(null);
  const [scoopCustomer, setScoopCustomer] = useState("");
  const [scoopMemo, setScoopMemo] = useState("");
  const [scoopReorder, setScoopReorder] = useState(false);
  const [scoopAnalysisText, setScoopAnalysisText] = useState("카테고리 자동 분석을 누르면 분석 결과가 표시됩니다.");
  const [scoopCategoryStats, setScoopCategoryStats] = useState([]);
  const [scoopExcludedCount, setScoopExcludedCount] = useState(0);
  const [scoopTargetMargin, setScoopTargetMargin] = useState("20");
  const [scoopRecType, setScoopRecType] = useState("전체 보기");
  const [scoopRecSort, setScoopRecSort] = useState("추천순");
  const [scoopSelectedCategories, setScoopSelectedCategories] = useState([]);
  const [scoopGapScope, setScoopGapScope] = useState("same");
  const [selectedOrderItems, setSelectedOrderItems] = useState([]);

  useEffect(() => {
    let mounted = true;

    async function initAuth() {
      const { data } = await supabase.auth.getSession();
      if (!mounted) return;
      setAuthUser(data?.session?.user || null);
      setAuthLoading(false);
    }

    initAuth();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthUser(session?.user || null);
      setAuthLoading(false);
    });

    return () => {
      mounted = false;
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!authUser) return;

    loadAll();

    const channels = [
      supabase.channel("products-live").on("postgres_changes", { event: "*", schema: "public", table: "products" }, getProducts).subscribe(),
      supabase.channel("orders-live").on("postgres_changes", { event: "*", schema: "public", table: "orders" }, getOrders).subscribe(),
      supabase.channel("order-items-live").on("postgres_changes", { event: "*", schema: "public", table: "order_items" }, getOrderItems).subscribe(),
      supabase.channel("materials-live").on("postgres_changes", { event: "*", schema: "public", table: "materials" }, getMaterials).subscribe(),
      supabase.channel("settings-live").on("postgres_changes", { event: "*", schema: "public", table: "settings" }, getSettings).subscribe(),
    ];

    return () => channels.forEach((c) => supabase.removeChannel(c));
  }, [authUser]);

  async function loadAll() {
    await Promise.all([getSettings(), getProducts(), getOrders(), getOrderItems(), getMaterials()]);
  }

  async function writeAudit(action, detail) {
    try {
      await supabase.from("audit_logs").insert([{ action, detail: String(detail || "") }]);
    } catch (e) {
      console.log("audit log failed", e);
    }
  }

  async function createInventoryBackup(reason = "manual") {
    const { data, error } = await supabase.from("products").select("*").order("id", { ascending: true });
    if (error) {
      alert("백업 생성 실패: " + error.message);
      return false;
    }
    const payload = JSON.stringify(data || []);
    const { error: insertError } = await supabase.from("inventory_backups").insert([{ reason, data: payload }]);
    if (insertError) {
      alert("백업 저장 실패: " + insertError.message);
      return false;
    }
    await writeAudit("inventory_backup", `${reason} / ${data?.length || 0} items`);
    return true;
  }

  async function restoreLatestInventoryBackup() {
    const ok = window.confirm("가장 최근 재고 백업으로 복구할까요? 현재 재고는 복구 전에 다시 백업됩니다.");
    if (!ok) return;

    const { data: backups, error } = await supabase
      .from("inventory_backups")
      .select("*")
      .order("id", { ascending: false })
      .limit(1);

    if (error || !backups || backups.length === 0) {
      alert("복구할 백업이 없어요.");
      return;
    }

    const beforeOk = await createInventoryBackup("restore_before_backup");
    if (!beforeOk) return;

    let rows = [];
    try {
      rows = JSON.parse(backups[0].data || "[]");
    } catch {
      alert("백업 데이터가 손상됐어요.");
      return;
    }

    const restoreRows = rows.map((p) => ({
      name: p.name,
      char1: p.char1,
      char2: p.char2,
      category: p.category,
      stock: toInt(p.stock),
      wholesale: toInt(p.wholesale),
      retail: toInt(p.retail),
      hidden: !!p.hidden,
    }));

    const { error: delErr } = await supabase.from("products").delete().neq("id", 0);
    if (delErr) return alert("현재 재고 삭제 실패: " + delErr.message);

    if (restoreRows.length > 0) {
      const { error: insErr } = await supabase.from("products").insert(restoreRows);
      if (insErr) return alert("백업 복구 실패: " + insErr.message);
    }

    await writeAudit("inventory_restore", `backup_id=${backups[0].id} / rows=${restoreRows.length}`);
    alert("최근 백업으로 재고를 복구했어요.");
    getProducts();
  }

  function downloadCurrentInventoryBackupFile() {
    const data = products.map((p) => ({
      상품명: p.name,
      캐릭터1: p.char1,
      캐릭터2: p.char2,
      카테고리: p.category,
      재고: p.stock,
      도매가: p.wholesale,
      소비자가: p.retail,
      히든: p.hidden ? "Y" : "",
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), "재고백업");
    XLSX.writeFile(wb, `재고백업_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  async function getProducts() {
    const { data, error } = await supabase.from("products").select("*").order("id", { ascending: false });
    if (error) return alert("재고 불러오기 실패: " + error.message);
    setProducts(data || []);
  }

  async function getOrders() {
    const { data, error } = await supabase.from("orders").select("*").order("id", { ascending: false });
    if (error) return console.log(error);
    setOrders(data || []);
  }

  async function getOrderItems() {
    const { data, error } = await supabase.from("order_items").select("*").order("id", { ascending: true });
    if (error) return console.log(error);
    setOrderItems(data || []);
  }

  async function getMaterials() {
    const { data, error } = await supabase.from("materials").select("*").order("id", { ascending: false });
    if (error) return console.log(error);
    setMaterials(data || []);
  }

  async function getSettings() {
    const { data, error } = await supabase.from("settings").select("*");
    if (error) return console.log(error);
    const map = {};
    (data || []).forEach((r) => { map[r.k] = r.v; });

    const s = map.default_sale || "39900";
    const f = map.default_fee || "3.63";
    setDefaultSale(s);
    setDefaultFee(f);
    setSalePrice((prev) => prev || s);
    setFeeRate((prev) => prev || f);
    setManualType(map.manual_type || "프리미엄박스");
    setManualBoxCount(map.manual_box_count || "1");
    setManualTargetMargin(map.manual_target_margin || "20");
    setManualRetailExtra(map.manual_retail_extra || "0");
    setManualHiddenDiscount(map.manual_hidden_discount || "5");
    setManualStyle(map.manual_style || "선택안함");
    setScoopGroupCount(map.scoop_groups || "6");
    setScoopMode(map.scoop_mode || "상품 수 균등");
    setScoopRetailLimit(map.scoop_retail_limit || "");
    setScoopTargetMargin(map.scoop_target_margin || "20");
    setScoopRecType(map.scoop_rec_type || "전체 보기");
    setScoopRecSort(map.scoop_rec_sort || "추천순");
  }

  async function saveSettings() {
    const payload = [
      { k: "default_sale", v: String(defaultSale || "39900") },
      { k: "default_fee", v: String(defaultFee || "3.63") },
      { k: "manual_type", v: String(manualType) },
      { k: "manual_box_count", v: String(manualBoxCount) },
      { k: "manual_target_margin", v: String(manualTargetMargin) },
      { k: "manual_retail_extra", v: String(manualRetailExtra) },
      { k: "manual_hidden_discount", v: String(manualHiddenDiscount) },
      { k: "manual_style", v: String(manualStyle) },
      { k: "scoop_groups", v: String(scoopGroupCount || "6") },
      { k: "scoop_mode", v: String(scoopMode || "상품 수 균등") },
      { k: "scoop_retail_limit", v: String(scoopRetailLimit || "") },
      { k: "scoop_target_margin", v: String(scoopTargetMargin || "20") },
      { k: "scoop_rec_type", v: String(scoopRecType || "전체 보기") },
      { k: "scoop_rec_sort", v: String(scoopRecSort || "추천순") },
    ];
    const { error } = await supabase.from("settings").upsert(payload);
    if (error) return alert("설정 저장 실패: " + error.message);
    setSalePrice(defaultSale);
    setFeeRate(defaultFee);
    alert("설정 저장 완료!");
  }

  const char1Options = useMemo(() => ["전체", ...Array.from(new Set(products.flatMap((p) => splitMultiValues(p.char1)))).sort()], [products]);
  const char2Options = useMemo(() => ["전체", ...Array.from(new Set(products.flatMap((p) => splitMultiValues(p.char2)))).sort()], [products]);
  const categoryOptions = useMemo(() => ["전체", ...Array.from(new Set(products.map((p) => p.category).filter(Boolean))).sort()], [products]);

  const filteredProducts = useMemo(() => {
    const kw = search.trim().toLowerCase();
    const rows = products.filter((p) => {
      const keyword =
        !kw ||
        String(p.name || "").toLowerCase().includes(kw) ||
        String(p.char1 || "").toLowerCase().includes(kw) ||
        String(p.char2 || "").toLowerCase().includes(kw) ||
        String(p.category || "").toLowerCase().includes(kw);
      const c1 = valueMatchesSelected(p.char1, char1Selected);
      const c2 = valueMatchesSelected(p.char2, char2Selected);
      const cat = categoryFilter === "전체" || p.category === categoryFilter;
      const price = inPriceRange(p.retail, priceFilter);
      const hidden = !hiddenOnly || p.hidden === true;
      const lowStock = !excludeLowStock || toInt(p.stock) >= 2;
      return keyword && c1 && c2 && cat && price && hidden && lowStock;
    });

    const sorted = [...rows];
    if (productSort === "도매가 낮은순") sorted.sort((a, b) => toInt(a.wholesale) - toInt(b.wholesale));
    if (productSort === "도매가 높은순") sorted.sort((a, b) => toInt(b.wholesale) - toInt(a.wholesale));
    if (productSort === "소비자가 낮은순") sorted.sort((a, b) => toInt(a.retail) - toInt(b.retail));
    if (productSort === "소비자가 높은순") sorted.sort((a, b) => toInt(b.retail) - toInt(a.retail));
    if (productSort === "재고 많은순") sorted.sort((a, b) => toInt(b.stock) - toInt(a.stock));
    if (productSort === "재고 적은순") sorted.sort((a, b) => toInt(a.stock) - toInt(b.stock));
    if (productSort === "상품명순") sorted.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ko"));
    return sorted;
  }, [products, search, char1Selected, char2Selected, categoryFilter, priceFilter, hiddenOnly, excludeLowStock, productSort]);

  const totalStock = products.reduce((s, p) => s + toInt(p.stock), 0);
  const totalWholesale = products.reduce((s, p) => s + toInt(p.stock) * toInt(p.wholesale), 0);
  const totalMaterials = materials.reduce((s, m) => s + toInt(m.amount), 0);
  const completedOrders = orders.filter((o) => o.status === "출고완료");
  const totalSales = completedOrders.reduce((s, o) => s + toInt(o.sale_price), 0);
  const totalNet = completedOrders.reduce((s, o) => s + toInt(o.net_amount), 0);
  const totalProfit = completedOrders.reduce((s, o) => s + toInt(o.profit), 0);
  const finance = calcFinance(composeItems, salePrice, feeRate);

  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      if (o.deleted_at) return false;
      const customerOk = !orderSearchCustomer.trim() || String(o.customer || "").toLowerCase().includes(orderSearchCustomer.trim().toLowerCase());
      const dateOk = !orderSearchDate.trim() || String(o.created_at || "").slice(0, 10) === orderSearchDate.trim();
      const reorderOk = !orderReorderOnly || toInt(o.reorder) === 1;
      return customerOk && dateOk && reorderOk;
    });
  }, [orders, orderSearchCustomer, orderSearchDate, orderReorderOnly]);


  const trashOrders = useMemo(() => {
    return orders.filter((o) => o.deleted_at);
  }, [orders]);

  function daysLeftForTrash(order) {
    if (!order.deleted_at) return "-";
    const deleted = new Date(order.deleted_at);
    if (Number.isNaN(deleted.getTime())) return "-";
    const ms = Date.now() - deleted.getTime();
    const daysPassed = Math.floor(ms / (1000 * 60 * 60 * 24));
    return Math.max(0, 30 - daysPassed);
  }

  const pendingOrders = filteredOrders.filter((o) => o.status !== "출고완료" && o.status !== "취소");
  const shippedOrders = filteredOrders.filter((o) => o.status === "출고완료");
  const canceledOrders = filteredOrders.filter((o) => o.status === "취소");

  function resetFilters() {
    setSearch("");
    setChar1Selected([]);
    setChar2Selected([]);
    setCategoryFilter("전체");
    setPriceFilter("전체");
    setHiddenOnly(false);
    setExcludeLowStock(false);
    setProductSort("기본순");
  }

  async function addProduct() {
    if (!productForm.name.trim()) return alert("상품명을 입력해줘.");
    const { error } = await supabase.from("products").insert([{
      name: productForm.name,
      char1: productForm.char1,
      char2: productForm.char2,
      category: productForm.category,
      stock: toInt(productForm.stock),
      wholesale: toInt(productForm.wholesale),
      retail: toInt(productForm.retail),
      hidden: !!productForm.hidden,
    }]);
    if (error) return alert("상품 저장 실패: " + error.message);
    setProductForm({ name: "", char1: "", char2: "", category: "", stock: "", wholesale: "", retail: "", hidden: false });
    getProducts();
  }

  async function deleteProduct(id) {
    if (!id) return alert("삭제할 상품을 선택해줘.");
    if (!window.confirm("선택한 상품을 삭제할까?")) return;
    const { error } = await supabase.from("products").delete().eq("id", id);
    if (error) return alert("상품 삭제 실패: " + error.message);
    setSelectedProductId(null);
    getProducts();
  }

  async function addMaterial() {
    if (!materialName.trim()) return alert("재료비명을 입력해줘.");
    if (toInt(materialAmount) <= 0) return alert("금액을 입력해줘.");
    const { error } = await supabase.from("materials").insert([{ name: materialName, amount: toInt(materialAmount) }]);
    if (error) return alert("재료비 저장 실패: " + error.message);
    setMaterialName("");
    setMaterialAmount("");
    setSelectedMaterialId(null);
    getMaterials();
  }

  async function deleteMaterial() {
    if (!selectedMaterialId) return alert("삭제할 재료비를 선택해줘.");
    if (!window.confirm("선택한 재료비를 삭제할까?")) return;
    const { error } = await supabase.from("materials").delete().eq("id", selectedMaterialId);
    if (error) return alert("재료비 삭제 실패: " + error.message);
    setSelectedMaterialId(null);
    getMaterials();
  }

  async function handleExcelUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const mode = window.prompt("엑셀 불러오기 방식\n1 = 기존 재고 전체 삭제 후 교체\n2 = 기존 재고 유지하고 추가", "2");
    if (mode !== "1" && mode !== "2") {
      e.target.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const workbook = XLSX.read(new Uint8Array(evt.target.result), { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        const formatted = json.map(productFromExcelRow).filter((x) => x.name);

        if (formatted.length === 0) {
          alert("불러올 상품이 없어요.\n엑셀 첫 줄 컬럼명을 확인해줘.");
          return;
        }

        setIsImportingExcel(true);

        const backupOk = await createInventoryBackup(mode === "1" ? "excel_replace_before" : "excel_add_before");
        if (!backupOk) {
          setIsImportingExcel(false);
          return;
        }

        if (mode === "1") {
          const confirmText = window.prompt("기존 재고 전체 삭제 후 교체합니다.\n자동 백업은 완료됐지만 신중하게 진행해야 해요.\n진행하려면 '교체' 라고 입력해줘.");
          if (confirmText !== "교체") {
            setIsImportingExcel(false);
            alert("재고 교체를 취소했어요.");
            return;
          }
          const { error: delErr } = await supabase.from("products").delete().neq("id", 0);
          if (delErr) {
            setIsImportingExcel(false);
            return alert("기존 재고 삭제 실패: " + delErr.message);
          }
        }

        const { error } = await supabase.from("products").insert(formatted);
        if (error) {
          setIsImportingExcel(false);
          return alert("엑셀 업로드 실패: " + error.message);
        }

        await writeAudit("excel_import", `${mode === "1" ? "replace" : "add"} / rows=${formatted.length}`);
        setIsImportingExcel(false);
        alert(`엑셀 ${mode === "1" ? "교체" : "추가"} 완료!\n불러온 상품 수: ${formatted.length}개\n업로드 전 재고는 자동 백업됐어요.`);
        getProducts();
      } catch (err) {
        console.error(err);
        alert("엑셀을 읽는 중 오류가 났어요.\n파일 형식 또는 컬럼명을 확인해줘.");
      } finally {
        setIsImportingExcel(false);
        e.target.value = "";
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function downloadInventoryExcel() {
    const data = products.map((p) => ({
      상품명: p.name, 캐릭터1: p.char1, 캐릭터2: p.char2, 카테고리: p.category,
      재고: p.stock, 도매가: p.wholesale, 소비자가: p.retail, 히든: p.hidden ? "Y" : "",
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), "재고");
    XLSX.writeFile(wb, "재고.xlsx");
  }

  function downloadOrdersExcel() {
    const data = orders.map((o) => ({
      주문ID: o.id, 주문일: o.created_at, 주문자: o.customer,
      재주문: toInt(o.reorder) === 1 ? "Y" : "", 상태: o.status,
      판매가: o.sale_price, 수수료율: o.fee_rate, 수수료: o.fee_amount,
      도매가합: o.wholesale_sum, 소비자가합: o.retail_sum,
      실수령액: o.net_amount, 순이익: o.profit, 취소사유: o.cancel_reason || "", 메모: o.memo || "",
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), "주문");
    XLSX.writeFile(wb, "주문.xlsx");
  }

  function showChar2Values() {
    const values = Array.from(new Set(products.flatMap((p) => splitMultiValues(p.char2)))).sort();
    alert(values.length ? `캐릭터2 목록 (${values.length}개)\n\n${values.join("\n")}` : "캐릭터2 목록이 없어요.");
  }

  function showCharacterShortage() {
    const map = {};
    products.forEach((p) => {
      splitMultiValues(p.char2).forEach((c) => {
        if (!map[c]) map[c] = { count: 0, stock: 0 };
        map[c].count += 1;
        map[c].stock += toInt(p.stock);
      });
    });
    const rows = Object.entries(map).map(([name, v]) => ({ name, ...v })).sort((a, b) => a.stock - b.stock);
    alert(rows.length ? rows.map((r) => `${r.name} | 상품종류 ${r.count}개 | 총재고 ${r.stock}개`).join("\n") : "계산할 캐릭터가 없어요.");
  }

  function addToCompose(product) {
    if (toInt(product.stock) <= 0) return alert("재고가 0개인 상품이에요.");
    setComposeItems((prev) => [...prev, product]);
  }

  function clearCompose() {
    setComposeItems([]);
    setCustomer("");
    setMemo("");
    setReorder(false);
  }

  async function checkAndReserveStock(items) {
    const needed = {};
    items.forEach((item) => { needed[item.id] = (needed[item.id] || 0) + 1; });

    const zeroWarnings = [];
    for (const pid of Object.keys(needed)) {
      const { data, error } = await supabase.from("products").select("id,name,stock").eq("id", pid).single();
      if (error || !data) {
        alert(`상품ID ${pid}를 찾지 못했어요.`);
        return false;
      }
      if (toInt(data.stock) < needed[pid]) {
        alert(`${data.name} 재고 부족\n필요 ${needed[pid]}개 / 현재 ${data.stock}개`);
        return false;
      }
      if (toInt(data.stock) - needed[pid] === 0) {
        zeroWarnings.push(`${data.name} | 현재 ${data.stock}개 → 출고 후 0개`);
      }
    }

    if (zeroWarnings.length > 0) {
      const ok = window.confirm(
        "아래 상품은 주문생성/박스출고 처리하면 임시차감되어 재고가 0개가 됩니다.\n\n" +
        zeroWarnings.join("\n") +
        "\n\n그래도 주문생성하고 재고를 임시차감할까요?"
      );
      if (!ok) return false;
    }

    for (const pid of Object.keys(needed)) {
      const { data } = await supabase.from("products").select("stock").eq("id", pid).single();
      await supabase.from("products").update({ stock: Math.max(0, toInt(data?.stock) - needed[pid]) }).eq("id", pid);
    }
    return true;
  }

  async function restoreStockFromItems(items) {
    const needed = {};
    (items || []).forEach((item) => { needed[item.id] = (needed[item.id] || 0) + 1; });

    for (const pid of Object.keys(needed)) {
      const { data: p } = await supabase.from("products").select("stock").eq("id", pid).single();
      if (!p) continue;
      await supabase.from("products").update({ stock: toInt(p.stock) + needed[pid] }).eq("id", pid);
    }
  }

  async function createOrderFromItems(items, orderCustomer, orderMemo, isReorder, orderSalePrice, orderFeeRate) {
    if (isShipping) return alert("이미 출고 처리 중이에요. 잠시만 기다려줘.");
    if (items.length === 0) return alert("상품이 없어요.");
    if (!String(orderCustomer || "").trim()) return alert("주문자명을 입력해줘.");

    setIsShipping(true);
    const finalOk = finalOrderConfirm(items, toInt(orderSalePrice), Number(orderFeeRate || 0), "주문생성 / 재고 임시차감");
    if (!finalOk) {
      setIsShipping(false);
      return;
    }

    const ok = await checkAndReserveStock(items);
    if (!ok) {
      setIsShipping(false);
      return;
    }

    const fin = calcFinance(items, orderSalePrice, orderFeeRate);
    const { data: order, error } = await supabase.from("orders").insert([{
      created_at: nowString(),
      customer: orderCustomer,
      reorder: isReorder ? 1 : 0,
      memo: orderMemo || "",
      sale_price: toInt(orderSalePrice),
      fee_rate: Number(orderFeeRate || 0),
      fee_amount: fin.feeAmount,
      wholesale_sum: fin.wholesaleSum,
      retail_sum: fin.retailSum,
      net_amount: fin.netAmount,
      profit: fin.profit,
      status: "주문접수(재고임시차감)",
      cancel_reason: "",
    }]).select().single();

    if (error) {
      await restoreStockFromItems(items);
      setIsShipping(false);
      return alert("주문 저장 실패로 임시차감 재고를 다시 복구했어요.\n" + error.message);
    }

    const payload = items.map((p) => ({
      order_id: order.id, product_id: p.id, name: p.name, qty: 1,
      wholesale: toInt(p.wholesale), retail: toInt(p.retail),
    }));
    const { error: itemErr } = await supabase.from("order_items").insert(payload);
    if (itemErr) {
      await restoreStockFromItems(items);
      if (order?.id) await supabase.from("orders").delete().eq("id", order.id);
      setIsShipping(false);
      return alert("주문 상품 저장 실패로 주문을 취소하고 임시차감 재고를 다시 복구했어요.\n" + itemErr.message);
    }

    await writeAudit("order_create", `order_id=${order.id} / customer=${orderCustomer} / items=${items.length}`);
    setIsShipping(false);
    alert(`주문 등록 완료! 주문ID: ${order.id}\n재고는 주문접수 상태에서 임시차감됐어요.\n취소하면 재고가 복구되고, 출고확정은 상태만 출고완료로 바뀝니다.`);
    getProducts();
    getOrders();
    getOrderItems();
    setActiveTab("주문관리");
  }

  async function createOrderFromCompose() {
    await createOrderFromItems(composeItems, customer, memo, reorder, salePrice, feeRate);
    clearCompose();
  }

  async function restoreStockByOrder(orderId) {
    const { data: items, error } = await supabase.from("order_items").select("*").eq("order_id", orderId);
    if (error) {
      alert("주문상품을 불러오지 못했어요.");
      return false;
    }
    for (const item of items || []) {
      const { data: p } = await supabase.from("products").select("stock").eq("id", item.product_id).single();
      if (!p) continue;
      await supabase.from("products").update({ stock: toInt(p.stock) + toInt(item.qty || 1) }).eq("id", item.product_id);
    }
    return true;
  }

  async function shipSelectedOrder() {
    if (!selectedOrderId) return alert("출고확정할 주문을 선택해줘.");
    const order = orders.find((o) => o.id === selectedOrderId);
    if (!order) return alert("주문 정보를 찾을 수 없어요.");
    if (order.status === "출고완료") return alert("이미 출고완료된 주문이에요.");
    if (order.status === "취소") return alert("취소된 주문은 출고확정할 수 없어요.");
    const ok = window.confirm("출고확정은 재고를 추가로 차감하지 않습니다.\n이미 주문생성 때 임시차감된 재고를 확정 처리하는 단계예요.\n출고완료로 변경할까요?");
    if (!ok) return;
    const { error } = await supabase.from("orders").update({ status: "출고완료" }).eq("id", selectedOrderId);
    if (error) return alert("출고확정 실패: " + error.message);
    alert("출고확정 완료! 재고는 추가 차감되지 않았어요.");
    setSelectedOrderId(null);
    getOrders();
  }

  async function cancelSelectedOrder() {
    if (!selectedOrderId) return alert("취소할 주문을 선택해줘.");
    const order = orders.find((o) => o.id === selectedOrderId);
    if (!order) return alert("주문 정보를 찾을 수 없어요.");
    if (order.status === "취소") return alert("이미 취소된 주문이에요.");
    if (order.deleted_at) return alert("이미 취소보관함에 들어간 주문이에요.");

    const reason = window.prompt(
      "취소사유를 입력해줘.\n\n" +
      "아래 중 하나로 입력:\n" +
      "환불 / 반품 / 취소 / 연습 / 기타\n\n" +
      "주의: 취소 시 주문 구성은 현재 주문상태로 보관되며, 취소 후에는 구성을 다시 복구해 출고상태로 되돌릴 수 없습니다.\n" +
      "재고는 주문생성 때 임시차감된 수량만큼 복구됩니다.",
      "취소"
    );
    if (reason === null) return;

    const cleanReason = reason.trim();
    const allowed = ["환불", "반품", "취소", "연습", "기타"];
    if (!allowed.includes(cleanReason)) {
      alert("취소사유는 환불 / 반품 / 취소 / 연습 / 기타 중 하나로 입력해줘.");
      return;
    }

    const warning = [
      "주문취소 최종 확인",
      "",
      `주문ID: ${order.id}`,
      `주문자: ${order.customer || "-"}`,
      `현재상태: ${order.status}`,
      `취소사유: ${cleanReason}`,
      "",
      "안내:",
      "- 주문접수건/출고확정건 모두 취소하면 재고가 복구됩니다.",
      "- 취소된 주문은 취소보관함에 30일 동안 보관됩니다.",
      "- 취소 후에는 이 주문 구성을 다시 출고상태로 복구할 수 없습니다.",
      "- 출고완료 건을 취소하는 경우, 환불/반품 처리를 실제로 했는지 꼭 확인하세요.",
      "",
      "정말 주문취소할까요?"
    ].join("\\n");

    if (!window.confirm(warning)) return;

    await restoreStockByOrder(selectedOrderId);

    if (cleanReason === "연습") {
      // 연습도 바로 삭제하지 않고 보관함으로 이동
      const { error } = await supabase.from("orders").update({
        status: "취소",
        cancel_reason: cleanReason,
        cancel_detail: "연습 주문",
        canceled_at: nowString(),
        deleted_at: nowString(),
      }).eq("id", selectedOrderId);
      if (error) return alert("연습 주문 취소 실패: " + error.message);
      await writeAudit("order_cancel_practice_to_trash", `order_id=${selectedOrderId}`);
      alert("연습 주문을 취소보관함으로 이동했고 재고를 복구했어요.");
    } else {
      const detail = window.prompt("추가 메모가 있으면 적어줘. 없으면 빈칸으로 확인.", "");
      const { error } = await supabase.from("orders").update({
        status: "취소",
        cancel_reason: cleanReason,
        cancel_detail: detail || "",
        canceled_at: nowString(),
        deleted_at: nowString(),
      }).eq("id", selectedOrderId);
      if (error) return alert("주문취소 실패: " + error.message);
      await writeAudit("order_cancel_to_trash", `order_id=${selectedOrderId} / reason=${cleanReason}`);
      alert("주문취소 완료! 재고가 복구됐고 취소보관함에 30일 보관됩니다.");
    }

    setSelectedOrderId(null);
    getProducts();
    getOrders();
    getOrderItems();
  }

  function showSelectedOrderItems() {
    if (!selectedOrderId) return alert("주문을 선택해줘.");
    const rows = orderItems.filter((x) => x.order_id === selectedOrderId);
    setSelectedOrderItems(rows);
    if (rows.length === 0) alert("해당 주문의 상품 목록이 없어요.");
  }

  function downloadCustomerOrderExcel() {
    const data = orders.map((o) => ({
      주문자명: o.customer,
      박스수량: 1,
      판매가: o.sale_price,
      상태: o.status,
      메모: o.memo || "",
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), "고객용주문");
    XLSX.writeFile(wb, "고객용_주문목록.xlsx");
  }

  function baseManualCandidates() {
    return products.filter((p) => {
      if (toInt(p.stock) <= 0) return false;
      if (!valueMatchesSelected(p.char1, manualPrefChar1)) return false;
      if (!valueMatchesSelected(p.char2, manualPrefChar2)) return false;
      return true;
    });
  }

  function targetItemCountByStyle() {
    if (manualStyle === "자잘자잘") return 8;
    if (manualStyle === "큼직큼직") return 4;
    if (manualStyle === "믹스") return 6;
    return 6;
  }

  function chooseUniqueByStock(pool, count, usedIds = new Set()) {
    const result = [];
    const localUsed = new Set(usedIds);
    for (const p of pool) {
      if (result.length >= count) break;
      if (localUsed.has(p.id)) continue;
      if (toInt(p.stock) <= 0) continue;
      result.push(p);
      localUsed.add(p.id);
    }
    return result;
  }


  function warnLowPreferredCharacters() {
    const selected = [...manualPrefChar1, ...manualPrefChar2];
    if (selected.length === 0) return true;

    const lowRows = selected.map((char) => {
      const rows = products.filter((p) => {
        const c1 = splitMultiValues(p.char1);
        const c2 = splitMultiValues(p.char2);
        return c1.includes(char) || c2.includes(char);
      });
      const stock = rows.reduce((s, p) => s + toInt(p.stock), 0);
      return { char, stock };
    }).filter((x) => x.stock <= 3);

    if (lowRows.length === 0) return true;

    return window.confirm(
      "선호 캐릭터 중 재고가 적은 캐릭터가 있어요.\n\n" +
      lowRows.map((x) => `${x.char}: 재고 ${x.stock}개`).join("\n") +
      "\n\n그래도 이 캐릭터들을 포함해서 추천안을 만들까요?"
    );
  }

  function overlapRate(aItems, bItems) {
    const a = new Set((aItems || []).map((p) => p.id));
    const b = new Set((bItems || []).map((p) => p.id));
    if (a.size === 0 || b.size === 0) return 0;
    let same = 0;
    a.forEach((id) => { if (b.has(id)) same += 1; });
    return same / Math.min(a.size, b.size);
  }

  function isTooSimilarToExisting(items, existingRecs, limit = 0.65) {
    return existingRecs.some((r) => overlapRate(items, r.items || []) >= limit);
  }

  function getZeroStockWarnings(items) {
    const need = {};
    (items || []).forEach((p) => { need[p.id] = (need[p.id] || 0) + 1; });
    return Object.entries(need).map(([id, qty]) => {
      const p = products.find((x) => String(x.id) === String(id));
      if (!p) return null;
      return toInt(p.stock) - qty === 0 ? `${p.name} | 현재 ${p.stock}개 → 출고 후 0개` : null;
    }).filter(Boolean);
  }

  function finalOrderConfirm(items, sale, fee, label = "출고") {
    const fin = calcFinance(items || [], sale, fee);
    const zeroWarnings = getZeroStockWarnings(items || []);
    const body = [
      `${label} 전 최종 확인`,
      "",
      `상품 수: ${(items || []).length}개`,
      `판매가: ${money(sale)}`,
      `도매가합: ${money(fin.wholesaleSum)}`,
      `소비자가합: ${money(fin.retailSum)}`,
      `수수료: ${money(fin.feeAmount)}`,
      `실수령액: ${money(fin.netAmount)}`,
      `순이익: ${money(fin.profit)}`,
      `마진율: ${fin.margin.toFixed(1)}%`,
      "",
      zeroWarnings.length ? "[출고 후 재고 0개 상품]\n" + zeroWarnings.join("\n") : "출고 후 재고 0개 상품 없음",
      "",
      "이대로 출고할까요?"
    ].join("\n");
    return window.confirm(body);
  }

  async function showBackupListAndRestore() {
    const { data, error } = await supabase
      .from("inventory_backups")
      .select("id,created_at,reason,data")
      .order("id", { ascending: false })
      .limit(10);

    if (error) return alert("백업 목록 불러오기 실패: " + error.message);
    if (!data || data.length === 0) return alert("저장된 백업이 없어요.");

    const msg = data.map((b) => {
      let count = 0;
      try { count = JSON.parse(b.data || "[]").length; } catch {}
      return `${b.id}: ${String(b.created_at).slice(0,19)} / ${b.reason || ""} / ${count}개`;
    }).join("\n");

    const id = window.prompt("복구할 백업 ID를 입력해줘.\n\n" + msg);
    if (!id) return;

    const picked = data.find((b) => String(b.id) === String(id));
    if (!picked) return alert("해당 백업 ID를 찾지 못했어요.");

    const previewRows = JSON.parse(picked.data || "[]");
    const ok = window.confirm(
      `백업 ID ${picked.id}로 복구할까요?\n` +
      `백업 시각: ${String(picked.created_at).slice(0,19)}\n` +
      `상품 수: ${previewRows.length}개\n\n` +
      "현재 재고는 복구 전 자동 백업됩니다."
    );
    if (!ok) return;

    const beforeOk = await createInventoryBackup("restore_before_selected_backup");
    if (!beforeOk) return;

    const restoreRows = previewRows.map((p) => ({
      name: p.name,
      char1: p.char1,
      char2: p.char2,
      category: p.category,
      stock: toInt(p.stock),
      wholesale: toInt(p.wholesale),
      retail: toInt(p.retail),
      hidden: !!p.hidden,
    }));

    const { error: delErr } = await supabase.from("products").delete().neq("id", 0);
    if (delErr) return alert("현재 재고 삭제 실패: " + delErr.message);

    if (restoreRows.length > 0) {
      const { error: insErr } = await supabase.from("products").insert(restoreRows);
      if (insErr) return alert("백업 복구 실패: " + insErr.message);
    }

    await writeAudit("inventory_restore_selected", `backup_id=${picked.id} / rows=${restoreRows.length}`);
    alert("선택한 백업으로 복구했어요.");
    getProducts();
  }

  function generateManualRecommendations() {
    if (!warnLowPreferredCharacters()) return;
    const poolRaw = baseManualCandidates();
    if (poolRaw.length === 0) return alert("추천할 후보 상품이 없어요.");

    const saleEach = toInt(salePrice || defaultSale);
    const boxCount = Math.max(1, toInt(manualBoxCount));
    const saleTotal = saleEach * boxCount;
    const fee = Number(feeRate || defaultFee || 0);
    const targetMargin = Number(manualTargetMargin || 0);
    const extraRetail = Math.max(0, toInt(manualRetailExtra || 0));

    // v16: 프리미엄/히든 특수 기준 제거.
    // 모든 유형은 기본적으로 목표마진~목표+5% 범위.
    // 본품 소비자가합은 판매가 + 추가소비자가 이상.
    // 소확행만 본품 완성 후 랜덤선물 추가.
    const minMargin = targetMargin;
    const maxMargin = targetMargin + 5;
    const retailTarget = saleTotal + extraRetail;
    const targetItemCount = targetItemCountByStyle() * boxCount;

    const normalPool = poolRaw.filter((p) => !p.hidden || manualType !== "히든박스");
    const hiddenPool = poolRaw.filter((p) => p.hidden);
    const giftPool = poolRaw.filter(isGiftCandidate);

    const recs = [];
    const signatures = new Set();
    let attempts = 0;

    while (recs.length < 10 && attempts < 1000) {
      attempts += 1;

      let items = [];
      const used = new Set();
      let gift = null;
      let note = `본품 소비자가합 ${money(retailTarget)} 이상 목표`;

      let pool = [...poolRaw].sort((a, b) => {
        const stockScore = (toInt(b.stock) - toInt(a.stock)) * 25;
        const randomScore = (Math.random() - 0.5) * 10000;
        const styleScore = scoreProductForStyle(b, manualStyle) - scoreProductForStyle(a, manualStyle);
        return styleScore + stockScore + randomScore;
      });

      if (manualType === "히든박스") {
        // 특수 마진 기준은 없애되, 히든박스 유형을 골랐으면 히든템 후보가 있으면 하나 정도 섞어볼 수 있게만 함.
        const hidden = hiddenPool
          .filter((p) => !used.has(p.id))
          .sort(() => 0.5 - Math.random())[0];
        if (hidden && Math.random() < 0.7) {
          items.push({ ...hidden, _tag: "히든 후보" });
          used.add(hidden.id);
          note += " / 히든 후보 포함";
        }
      }

      // 다양한 조합을 만들기 위해 시작 구간을 랜덤하게 밀어줌
      const offset = Math.floor(Math.random() * Math.max(1, Math.min(pool.length, 30)));
      pool = [...pool.slice(offset), ...pool.slice(0, offset)];

      for (const p of pool) {
        const bodyRetail = retailSumOf(bodyItemsOf(items));
        if (items.length >= targetItemCount && bodyRetail >= retailTarget) break;
        if (used.has(p.id)) continue;
        items.push({ ...p, _tag: manualType === "프리미엄박스" ? "본품" : "본품" });
        used.add(p.id);
      }

      let guard = 0;
      while (retailSumOf(bodyItemsOf(items)) < retailTarget && guard < 50) {
        const gap = retailTarget - retailSumOf(bodyItemsOf(items));
        const add = poolRaw
          .filter((p) => !used.has(p.id))
          .sort((a, b) => {
            const aScore = Math.abs(toInt(a.retail) - gap) - toInt(a.stock) * 20 + Math.random() * 3000;
            const bScore = Math.abs(toInt(b.retail) - gap) - toInt(b.stock) * 20 + Math.random() * 3000;
            return aScore - bScore;
          })[0];
        if (!add) break;
        items.push({ ...add, _tag: "본품 보정" });
        used.add(add.id);
        guard += 1;
      }

      if (manualType === "소확행") {
        gift = giftPool
          .filter((p) => !used.has(p.id))
          .sort((a, b) => toInt(b.stock) - toInt(a.stock) || Math.random() - 0.5)[0];
        if (gift) {
          items.push({ ...gift, _tag: "랜덤선물" });
          used.add(gift.id);
          note += ` / 랜덤선물 추가: ${gift.name}`;
        } else {
          note += " / 랜덤선물 후보 없음";
        }
      }

      let fin = calcFinance(items, saleTotal, fee);

      // 마진이 너무 높으면 원가가 더 높은 상품으로 교체
      guard = 0;
      while (fin.margin > maxMargin && guard < 60) {
        const candidates = items
          .map((p, idx) => ({ p, idx }))
          .filter(({ p }) => p._tag !== "랜덤선물")
          .sort((a, b) => toInt(a.p.wholesale) - toInt(b.p.wholesale));

        let replaced = false;
        for (const { p: oldItem, idx } of candidates) {
          const replacement = poolRaw
            .filter((p) => !items.some((x, j) => j !== idx && x.id === p.id))
            .filter((p) => toInt(p.wholesale) > toInt(oldItem.wholesale))
            .sort((a, b) => {
              const aFin = calcFinance([...items.slice(0, idx), { ...a, _tag: oldItem._tag || "마진상한보정" }, ...items.slice(idx + 1)], saleTotal, fee);
              const bFin = calcFinance([...items.slice(0, idx), { ...b, _tag: oldItem._tag || "마진상한보정" }, ...items.slice(idx + 1)], saleTotal, fee);
              return Math.abs(aFin.margin - targetMargin) - Math.abs(bFin.margin - targetMargin) + (Math.random() - 0.5) * 2;
            })[0];

          if (replacement) {
            items[idx] = { ...replacement, _tag: oldItem._tag || "마진상한보정" };
            fin = calcFinance(items, saleTotal, fee);
            replaced = true;
            break;
          }
        }
        if (!replaced) break;
        guard += 1;
      }

      // 마진이 너무 낮으면 원가 낮은 유사 소비자가 상품으로 교체
      guard = 0;
      while (fin.margin < minMargin && guard < 60) {
        const candidates = items
          .map((p, idx) => ({ p, idx }))
          .filter(({ p }) => p._tag !== "랜덤선물")
          .sort((a, b) => toInt(b.p.wholesale) - toInt(a.p.wholesale));

        let replaced = false;
        for (const { p: oldItem, idx } of candidates) {
          const replacement = poolRaw
            .filter((p) => !items.some((x, j) => j !== idx && x.id === p.id))
            .filter((p) => toInt(p.wholesale) < toInt(oldItem.wholesale))
            .sort((a, b) => {
              const aFin = calcFinance([...items.slice(0, idx), { ...a, _tag: oldItem._tag || "마진하한보정" }, ...items.slice(idx + 1)], saleTotal, fee);
              const bFin = calcFinance([...items.slice(0, idx), { ...b, _tag: oldItem._tag || "마진하한보정" }, ...items.slice(idx + 1)], saleTotal, fee);
              return Math.abs(aFin.margin - targetMargin) - Math.abs(bFin.margin - targetMargin) + (Math.random() - 0.5) * 2;
            })[0];

          if (replacement) {
            items[idx] = { ...replacement, _tag: oldItem._tag || "마진하한보정" };
            fin = calcFinance(items, saleTotal, fee);
            replaced = true;
            break;
          }
        }
        if (!replaced) break;
        guard += 1;
      }

      const bodyItems = bodyItemsOf(items);
      const bodyRetailSum = retailSumOf(bodyItems);
      const ids = bodyItems.map((p) => p.id).sort((a, b) => a - b).join("-");
      if (signatures.has(ids)) continue;

      const chars = Array.from(new Set(items.flatMap((p) => splitMultiValues(p.char2)))).slice(0, 8).join(", ");

      if (bodyRetailSum >= retailTarget && fin.margin >= minMargin && fin.margin <= maxMargin && !isTooSimilarToExisting(items, recs, 0.65)) {
        signatures.add(ids);
        recs.push({
          name: `추천안${recs.length + 1}`,
          type: manualType,
          boxCount,
          saleTotal,
          feeRate: fee,
          items,
          finance: fin,
          chars,
          note,
          retailGap: retailTarget - bodyRetailSum,
          bodyRetailSum,
          retailTarget,
          marginRangeText: `${minMargin}%~${maxMargin}%`,
          giftName: gift?.name || "",
          diversityText: recs.length === 0 ? "첫 추천안" : `겹침 최대 ${(Math.max(...recs.map((r) => overlapRate(items, r.items || [])), 0) * 100).toFixed(0)}%`,
        });
      }
    }

    if (recs.length === 0) {
      alert(`조건에 맞는 추천안을 만들지 못했어요.\\n마진 허용범위 ${minMargin}%~${maxMargin}% / 본품 소비자가 목표 ${money(retailTarget)} 조건을 만족하는 조합이 부족해요.`);
      setManualRecommendations([]);
      setSelectedManualIndex(null);
      return;
    }

    setManualRecommendations(recs);
    setSelectedManualIndex(0);
  }

  function applyManualRecommendation() {
    const rec = manualRecommendations[selectedManualIndex];
    if (!rec) return alert("추천안을 선택해줘.");
    setComposeItems(rec.items);
    setSalePrice(String(rec.saleTotal));
    setFeeRate(String(rec.feeRate));
    setActiveTab("수동박스");
  }

  function showCharacterBoxCapacity() {
    const all = products.filter((p) => toInt(p.stock) > 0);
    if (all.length === 0) return alert("계산할 재고가 없어요.");

    const sale = toInt(salePrice || defaultSale);
    const fee = Number(feeRate || defaultFee || 0);
    const targetMargin = Number(manualTargetMargin || 0);
    const minMargin = manualType === "히든박스" ? Math.max(0, targetMargin - Number(manualHiddenDiscount || 0)) : targetMargin;
    const maxMargin = targetMargin + 5;
    const itemCountText = window.prompt("박스 1개당 대략 상품 개수를 입력해줘.\\n예: 6", String(targetItemCountByStyle()));
    if (itemCountText === null) return;
    const itemCount = Math.max(1, toInt(itemCountText));

    const charMap = {};
    all.forEach((p) => {
      const chars = splitMultiValues(p.char2 || p.char1 || "미분류");
      chars.forEach((c) => {
        if (!charMap[c]) charMap[c] = [];
        charMap[c].push(p);
      });
    });

    const rows = Object.entries(charMap).map(([char, rows]) => {
      const totalStock = rows.reduce((s, p) => s + toInt(p.stock), 0);
      const sorted = [...rows].sort((a, b) => {
        const aScore = Math.abs(toInt(a.retail) - sale / itemCount) + Math.abs(toInt(a.wholesale) - (sale * (1 - targetMargin / 100)) / itemCount);
        const bScore = Math.abs(toInt(b.retail) - sale / itemCount) + Math.abs(toInt(b.wholesale) - (sale * (1 - targetMargin / 100)) / itemCount);
        return aScore - bScore;
      });

      let possible = 0;
      const maxByStock = Math.floor(totalStock / itemCount);
      for (let box = 1; box <= maxByStock; box++) {
        let virtual = [];
        const stockLeft = {};
        sorted.forEach((p) => { stockLeft[p.id] = toInt(p.stock); });

        for (let i = 0; i < itemCount; i++) {
          const pick = sorted.find((p) => stockLeft[p.id] > 0);
          if (!pick) break;
          virtual.push(pick);
          stockLeft[pick.id] -= 1;
        }

        const fin = calcFinance(virtual, sale, fee);
        if (virtual.length === itemCount && fin.retailSum >= sale && fin.margin >= minMargin && fin.margin <= maxMargin) {
          possible = Math.max(possible, box);
          sorted.forEach((p) => { stockLeft[p.id] = Math.max(0, stockLeft[p.id] - 1); });
        } else {
          // 단순 재고 기반 대략 계산이므로 조건 실패 시 재고 기반 최소값까지만 표시
          possible = Math.min(possible || maxByStock, maxByStock);
          break;
        }
      }

      const avgRetail = rows.reduce((s, p) => s + toInt(p.retail), 0) / Math.max(1, rows.length);
      const avgWholesale = rows.reduce((s, p) => s + toInt(p.wholesale), 0) / Math.max(1, rows.length);
      return {
        char,
        itemKinds: rows.length,
        totalStock,
        avgRetail: Math.round(avgRetail),
        avgWholesale: Math.round(avgWholesale),
        possible: Math.max(0, possible),
        maxByStock,
      };
    }).sort((a, b) => b.possible - a.possible || b.totalStock - a.totalStock);

    const text = rows.map((r) =>
      `${r.char} | 재고 ${r.totalStock}개 | 상품종류 ${r.itemKinds}종 | 평균소비자가 ${money(r.avgRetail)} | 평균도매가 ${money(r.avgWholesale)} | 대략 가능 ${r.possible}박스 (재고상 최대 ${r.maxByStock}박스)`
    ).join("\\n");

    alert(
      `계산 기준: 판매가 ${money(sale)} / 수수료율 ${fee}% / 마진 ${minMargin}%~${maxMargin}% / 박스당 ${itemCount}개\\n\\n` +
      (text || "계산할 캐릭터가 없어요.")
    );
  }

  function manualGapRecommendations() {
    const rec = manualRecommendations[selectedManualIndex];
    if (!rec) return alert("추천안을 선택해줘.");
    const gap = rec.saleTotal - rec.finance.retailSum;
    const pool = baseManualCandidates()
      .filter((p) => !rec.items.some((x) => x.id === p.id))
      .sort((a, b) => Math.abs(toInt(a.retail) - gap) - Math.abs(toInt(b.retail) - gap))
      .slice(0, 20);
    alert(pool.length ? pool.map((p) => `${p.name} | 소비자가 ${money(p.retail)} | 도매가 ${money(p.wholesale)}`).join("\n") : "추천할 상품이 없어요.");
  }

  function addManualGapItem() {
    const rec = manualRecommendations[selectedManualIndex];
    if (!rec) return alert("추천안을 선택해줘.");
    const gap = rec.saleTotal - rec.finance.retailSum;
    const add = baseManualCandidates()
      .filter((p) => !rec.items.some((x) => x.id === p.id))
      .sort((a, b) => Math.abs(toInt(a.retail) - gap) - Math.abs(toInt(b.retail) - gap))[0];
    if (!add) return alert("추가할 상품이 없어요.");
    const next = [...manualRecommendations];
    const items = [...rec.items, add];
    next[selectedManualIndex] = { ...rec, items, finance: calcFinance(items, rec.saleTotal, rec.feeRate), retailGap: rec.saleTotal - items.reduce((s,p)=>s+toInt(p.retail),0), note: rec.note + " / 부족금액 추가" };
    setManualRecommendations(next);
  }

  function addSelectedProductToManualRecommendation() {
    const rec = manualRecommendations[selectedManualIndex];
    if (!rec) return alert("추천안을 선택해줘.");
    const product = products.find((p) => p.id === selectedProductId);
    if (!product) return alert("조건 상품 리스트에서 추가할 상품을 선택해줘.");
    const items = [...rec.items, product];
    const next = [...manualRecommendations];
    next[selectedManualIndex] = {
      ...rec,
      items,
      finance: calcFinance(items, rec.saleTotal, rec.feeRate),
      retailGap: rec.saleTotal - items.reduce((s, p) => s + toInt(p.retail), 0),
      note: rec.note + " / 수동상품 추가",
    };
    setManualRecommendations(next);
  }

  function removeManualRecommendationItem(index) {
    const rec = manualRecommendations[selectedManualIndex];
    if (!rec) return alert("추천안을 선택해줘.");
    const items = rec.items.filter((_, i) => i !== index);
    const next = [...manualRecommendations];
    next[selectedManualIndex] = {
      ...rec,
      items,
      finance: calcFinance(items, rec.saleTotal, rec.feeRate),
      retailGap: rec.saleTotal - items.reduce((s, p) => s + toInt(p.retail), 0),
      note: rec.note + " / 상품 삭제 수정",
    };
    setManualRecommendations(next);
  }

  async function createOrderFromManualRecommendation() {
    const rec = manualRecommendations[selectedManualIndex];
    if (!rec) return alert("추천안을 선택해줘.");
    await createOrderFromItems(rec.items, manualCustomer, manualMemo, manualReorder, rec.saleTotal, rec.feeRate);
  }

  function scoopCandidateProductsWithExcluded() {
    const available = [];
    const excluded = [];
    products.forEach((p) => {
      if (toInt(p.stock) <= 0) return;
      if (!valueMatchesSelected(p.char1, scoopChar1Selected)) return;
      if (!valueMatchesSelected(p.char2, scoopChar2Selected)) return;
      if (!inPriceRange(p.retail, scoopPrice)) return;
      if (scoopRetailLimit && toInt(p.retail) >= toInt(scoopRetailLimit)) {
        excluded.push(p);
        return;
      }
      available.push(p);
    });
    return { available, excluded };
  }

  function scoopCandidateProducts() {
    return scoopCandidateProductsWithExcluded().available;
  }

  function buildCategoryStats(pool) {
    const map = {};
    pool.forEach((p) => {
      const cat = p.category || "미분류";
      if (!map[cat]) map[cat] = { category: cat, products: [], stockSum: 0, retailSum: 0, count: 0 };
      map[cat].products.push(p);
      map[cat].stockSum += toInt(p.stock);
      map[cat].retailSum += toInt(p.retail);
      map[cat].count += 1;
    });
    return Object.values(map).map((g) => ({
      ...g,
      avgRetail: Math.round(g.retailSum / Math.max(1, g.count)),
    })).sort((a, b) => b.stockSum - a.stockSum);
  }

  function makeManualCategoryGroup() {
    if (scoopSelectedCategories.length < 2) return alert("묶을 카테고리를 2개 이상 선택해줘.");
    const pool = scoopCandidateProducts();
    const selectedProducts = pool.filter((p) => scoopSelectedCategories.includes(p.category || "미분류"));
    if (selectedProducts.length === 0) return alert("선택 카테고리에 해당하는 상품이 없어요.");

    const groupName = window.prompt("그룹명을 입력해줘.", scoopSelectedCategories.join(", "));
    if (!groupName) return;

    const group = {
      id: Date.now(),
      name: groupName,
      categories: [...scoopSelectedCategories],
      products: selectedProducts,
      stock: selectedProducts.reduce((s, p) => s + toInt(p.stock), 0),
      avgRetail: Math.round(selectedProducts.reduce((s, p) => s + toInt(p.retail), 0) / Math.max(1, selectedProducts.length)),
      partQty: 1,
      partPercent: 0,
      reason: "사용자 수동 묶기",
    };

    setScoopGroups((prev) => {
      const without = prev.filter((g) => !g.categories.some((c) => scoopSelectedCategories.includes(c)));
      const next = [...without, group].map((g, i) => ({ ...g, id: i + 1 }));
      const totalStock = next.reduce((sum, g) => sum + toInt(g.stock), 0);
      return next.map((g) => {
        const percent = totalStock > 0 ? (toInt(g.stock) / totalStock) * 100 : 0;
        return { ...g, partPercent: Number(percent.toFixed(1)), partQty: g.partQty || Math.max(1, Math.round(percent / 20)) };
      });
    });
    setScoopSelectedCategories([]);
  }

  function toggleScoopCategory(category) {
    setScoopSelectedCategories((prev) => prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]);
  }

  function makeAutoScoopGroups(stats) {
    if (!stats.length) return [];
    const avgStock = stats.reduce((s, x) => s + x.stockSum, 0) / Math.max(1, stats.length);
    const threshold = Math.max(1, Math.floor(avgStock * 0.5));
    let large = stats.filter((s) => s.stockSum > threshold);
    let small = stats.filter((s) => s.stockSum <= threshold);

    if (large.length === 0) {
      large = stats.slice(0, 1);
      small = stats.slice(1);
    }

    const groups = large.map((s, i) => ({
      id: i + 1,
      name: `그룹 ${String.fromCharCode(65 + i)}`,
      categories: [s.category],
      products: [...s.products],
      stock: s.stockSum,
      avgRetail: s.avgRetail,
      partQty: null,
      reason: "기본 그룹",
    }));

    small.forEach((s) => {
      const idx = groups.reduce((best, g, i) => g.stock < groups[best].stock ? i : best, 0);
      const baseName = groups[idx].categories[0];
      groups[idx].categories.push(s.category);
      groups[idx].products.push(...s.products);
      groups[idx].stock += s.stockSum;
      groups[idx].avgRetail = Math.round(groups[idx].products.reduce((sum, p) => sum + toInt(p.retail), 0) / Math.max(1, groups[idx].products.length));
      groups[idx].reason = `${s.category}: 재고 부족으로 ${baseName} 그룹에 합쳐짐`;
    });

    const totalStock = groups.reduce((sum, g) => sum + toInt(g.stock), 0);
    groups.forEach((g, i) => {
      const percent = totalStock > 0 ? (toInt(g.stock) / totalStock) * 100 : 0;
      g.partPercent = Number(percent.toFixed(1));
      g.partQty = Math.max(1, Math.round(percent / 20));
      g.id = i + 1;
    });
    return groups;
  }

  function buildScoopAnalysisText(stats, groups, excludedCount) {
    if (!stats.length) return "조건에 맞는 상품이 없습니다.";
    const statLines = stats.map((s) => `${s.category}: 재고 ${s.stockSum} / 평균소비자가 ${money(s.avgRetail)} / 상품수 ${s.count}`);
    const groupLines = groups.map((g) => `${g.name}: ${g.categories.join(", ")} / 재고 ${g.stock} / 평균 ${money(g.avgRetail)} / 파츠 ${g.partQty}개(추천 ${g.partPercent || 0}%) / ${g.reason}`);
    return [
      `사용 가능 상품 수 ${stats.reduce((sum, s) => sum + s.count, 0)}개 | 배제된 상품 수 ${excludedCount}개`,
      "",
      "[카테고리 목록]",
      ...statLines,
      "",
      "[자동 그룹 제안]",
      ...groupLines,
    ].join("\n");
  }

  function analyzeScoopCategories() {
    const { available, excluded } = scoopCandidateProductsWithExcluded();
    const stats = buildCategoryStats(available);
    const groups = makeAutoScoopGroups(stats);
    setScoopCategoryStats(stats);
    setScoopExcludedCount(excluded.length);
    setScoopAnalysisText(buildScoopAnalysisText(stats, groups, excluded.length));

    if (!stats.length) {
      setScoopGroups([]);
      setScoopRecommendations([]);
      return alert("조건에 맞는 상품이 없어요.");
    }

    const merged = groups.some((g) => g.categories.length > 1);
    const ok = window.confirm(
      `${merged ? "재고가 부족한 카테고리는 자동으로 합쳐졌어요.\n" : ""}` +
      `카테고리 ${stats.length}개를 ${groups.length}개 그룹으로 제안합니다.\n\n` +
      groups.map((g) => `${g.name}: ${g.categories.join(", ")} / 파츠 ${g.partQty}개`).join("\n") +
      "\n\n이 그룹으로 적용할까요?"
    );

    if (ok) {
      setScoopGroups(groups);
      setScoopRecommendations([]);
    }
  }

  function generateScoopGroups() {
    const count = Math.max(1, toInt(scoopGroupCount));
    const { available, excluded } = scoopCandidateProductsWithExcluded();
    const pool = available;
    if (pool.length === 0) return alert("그룹을 만들 후보 상품이 없어요.");

    const groups = Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      name: `그룹 ${String.fromCharCode(65 + i)}`,
      products: [],
      stock: 0,
      avgRetail: 0,
      partQty: 1,
      partPercent: 0,
      categories: [],
      reason: scoopMode,
    }));

    const sorted = [...pool].sort((a, b) => {
      if (scoopMode === "소비자가 균등") return toInt(b.retail) - toInt(a.retail);
      if (scoopMode === "도매가 균등") return toInt(b.wholesale) - toInt(a.wholesale);
      if (scoopMode === "혼합 균형") return (toInt(b.retail) + toInt(b.wholesale)) - (toInt(a.retail) + toInt(a.wholesale));
      return 0.5 - Math.random();
    });

    sorted.forEach((p, idx) => {
      const target = groups[idx % groups.length];
      target.products.push(p);
      target.stock += toInt(p.stock);
      if (p.category && !target.categories.includes(p.category)) target.categories.push(p.category);
    });

    const totalStock = groups.reduce((sum, g) => sum + toInt(g.stock), 0);
    groups.forEach((g) => {
      g.avgRetail = Math.round(g.products.reduce((s, p) => s + toInt(p.retail), 0) / Math.max(1, g.products.length));
      const percent = totalStock > 0 ? (toInt(g.stock) / totalStock) * 100 : 0;
      g.partPercent = Number(percent.toFixed(1));
      g.partQty = Math.max(1, Math.round(percent / 20));
    });

    const stats = buildCategoryStats(pool);
    setScoopCategoryStats(stats);
    setScoopExcludedCount(excluded.length);
    setScoopAnalysisText(buildScoopAnalysisText(stats, groups, excluded.length));
    setScoopGroups(groups);
    setScoopRecommendations([]);
  }

  function updateScoopPartQty(groupId, qty) {
    setScoopGroups((prev) => prev.map((g) => g.id === groupId ? { ...g, partQty: Math.max(0, toInt(qty)) } : g));
  }

  function renameScoopGroup(groupId) {
    const g = scoopGroups.find((x) => x.id === groupId);
    if (!g) return;
    const name = window.prompt("그룹명 수정", g.name);
    if (!name) return;
    setScoopGroups((prev) => prev.map((x) => x.id === groupId ? { ...x, name } : x));
  }

  async function saveScoopGroups() {
    if (scoopGroups.length === 0) return alert("저장할 그룹이 없어요.");
    const name = window.prompt("저장할 그룹 이름", `스쿱그룹 ${nowString()}`);
    if (!name) return;
    const { error } = await supabase.from("saved_scoop_groups").insert([{ name, data: JSON.stringify(scoopGroups) }]);
    if (error) return alert("그룹 저장 실패: " + error.message);
    alert("그룹 저장 완료");
  }

  async function loadScoopGroups() {
    const { data, error } = await supabase.from("saved_scoop_groups").select("*").order("id", { ascending: false });
    if (error) return alert("그룹 불러오기 실패: " + error.message);
    if (!data?.length) return alert("저장된 그룹이 없어요.");
    const msg = data.map((g) => `${g.id}: ${g.name}`).join("\n");
    const id = window.prompt(`불러올 그룹 ID 입력\n\n${msg}`);
    if (!id) return;
    const row = data.find((g) => String(g.id) === String(id));
    if (!row) return alert("해당 ID를 찾지 못했어요.");
    try {
      setScoopGroups(JSON.parse(row.data || "[]"));
      alert("그룹을 불러왔어요.");
    } catch {
      alert("저장 데이터가 깨졌어요.");
    }
  }


  function selectedScoopPrefChars() {
    return Array.from(new Set([...(scoopChar1Selected || []), ...(scoopChar2Selected || [])])).filter(Boolean);
  }

  function checkScoopPreferredCharStock() {
    const selected = selectedScoopPrefChars();
    if (selected.length === 0) return true;

    const rows = selected.map((char) => {
      const stock = products
        .filter((p) => productCharacters(p).includes(char))
        .reduce((s, p) => s + toInt(p.stock), 0);
      return { char, stock };
    });

    const low = rows.filter((x) => x.stock <= 3);
    if (low.length === 0) return true;

    return window.confirm(
      "선택한 선호 캐릭터 중 재고가 적어서 추천안에 충분히 반영되지 않을 수 있어요.\\n\\n" +
      low.map((x) => `${x.char}: 재고 ${x.stock}개`).join("\\n") +
      "\\n\\n재고가 부족한 경우 다른 캐릭터가 섞일 수 있습니다. 그래도 추천안을 만들까요?"
    );
  }

  function scoopPreferenceNote(items) {
    const selected = selectedScoopPrefChars();
    if (selected.length === 0) return "선호 캐릭터 미선택";
    const included = Array.from(new Set((items || []).flatMap((p) => productCharacters(p))));
    const reflected = selected.filter((c) => included.includes(c));
    const missing = selected.filter((c) => !included.includes(c));
    const others = included.filter((c) => !selected.includes(c));

    const parts = [];
    parts.push(reflected.length ? `선호 반영: ${reflected.join(", ")}` : "선호 반영 없음");
    if (missing.length) parts.push(`부족/미반영: ${missing.join(", ")}`);
    if (others.length) parts.push(`다른 캐릭터 섞임: ${others.slice(0, 6).join(", ")}`);
    return parts.join(" / ");
  }

  function generateScoopRecommendations() {
    if (scoopGroups.length === 0) return alert("먼저 그룹을 만들어줘.");
    if (!checkScoopPreferredCharStock()) return;

    const sale = toInt(salePrice || defaultSale);
    const fee = Number(feeRate || defaultFee || 0);
    const targetMargin = Number(scoopTargetMargin || 0);
    const minMargin = targetMargin;
    const maxMargin = targetMargin + 5;
    const allPool = scoopCandidateProducts();
    const preferredSet = new Set(selectedScoopPrefChars());
    const preferredScoopPool = [...scoopCandidateProducts()].sort((a, b) => {
      const aPref = productCharacters(a).some((c) => preferredSet.has(c)) ? 1 : 0;
      const bPref = productCharacters(b).some((c) => preferredSet.has(c)) ? 1 : 0;
      return bPref - aPref || toInt(b.stock) - toInt(a.stock);
    });
    const recs = [];
    let attempts = 0;

    while (recs.length < 12 && attempts < 600) {
      attempts += 1;
      let items = [];
      const used = new Set();
      let type = "기본";

      scoopGroups.forEach((g) => {
        let pool = [...(g.products || [])].filter((p) => toInt(p.stock) > 0 && !used.has(p.id));
        if (scoopMode === "소비자가 균등") pool.sort((a, b) => toInt(b.retail) - toInt(a.retail));
        else if (scoopMode === "도매가 균등") pool.sort((a, b) => toInt(a.wholesale) - toInt(b.wholesale));
        else if (scoopMode === "혼합 균형") pool.sort((a, b) => (toInt(b.retail) - toInt(b.wholesale)) - (toInt(a.retail) - toInt(a.wholesale)));
        else pool.sort(() => 0.5 - Math.random());

        const qty = Math.max(1, toInt(g.partQty || 1));
        pool.slice(0, qty).forEach((p) => {
          if (!used.has(p.id)) {
            items.push({ ...p, _groupName: g.name, _tag: "기본" });
            used.add(p.id);
          }
        });
      });

      let fin = calcFinance(items, sale, fee);

      let guard = 0;
      while (fin.retailSum < sale && guard < 30) {
        const gap = sale - fin.retailSum;
        const add = findClosestRetailProduct(allPool, gap, used);
        if (!add) break;
        items.push({ ...add, _tag: "소비자가 보정" });
        used.add(add.id);
        fin = calcFinance(items, sale, fee);
        type = "부분 업그레이드";
        guard += 1;
      }

      guard = 0;
      while (fin.margin > maxMargin && guard < 40) {
        const candidates = items
          .map((p, idx) => ({ p, idx }))
          .sort((a, b) => toInt(a.p.wholesale) - toInt(b.p.wholesale));

        let replaced = false;
        for (const { p: oldItem, idx } of candidates) {
          const replacement = allPool
            .filter((p) => !items.some((x, j) => j !== idx && x.id === p.id))
            .filter((p) => toInt(p.wholesale) > toInt(oldItem.wholesale))
            .sort((a, b) => {
              const aFin = calcFinance([...items.slice(0, idx), { ...a, _tag: "마진상한보정" }, ...items.slice(idx + 1)], sale, fee);
              const bFin = calcFinance([...items.slice(0, idx), { ...b, _tag: "마진상한보정" }, ...items.slice(idx + 1)], sale, fee);
              return Math.abs(aFin.margin - targetMargin) - Math.abs(bFin.margin - targetMargin);
            })[0];

          if (replacement) {
            items[idx] = { ...replacement, _tag: "마진상한보정" };
            fin = calcFinance(items, sale, fee);
            type = "부분 업그레이드";
            replaced = true;
            break;
          }
        }
        if (!replaced) break;
        guard += 1;
      }

      guard = 0;
      while (fin.margin < minMargin && guard < 40) {
        const candidates = items
          .map((p, idx) => ({ p, idx }))
          .sort((a, b) => toInt(b.p.wholesale) - toInt(a.p.wholesale));

        let replaced = false;
        for (const { p: oldItem, idx } of candidates) {
          const replacement = allPool
            .filter((p) => !items.some((x, j) => j !== idx && x.id === p.id))
            .filter((p) => toInt(p.wholesale) < toInt(oldItem.wholesale))
            .sort((a, b) => {
              const aFin = calcFinance([...items.slice(0, idx), { ...a, _tag: "마진하한보정" }, ...items.slice(idx + 1)], sale, fee);
              const bFin = calcFinance([...items.slice(0, idx), { ...b, _tag: "마진하한보정" }, ...items.slice(idx + 1)], sale, fee);
              return Math.abs(aFin.margin - targetMargin) - Math.abs(bFin.margin - targetMargin);
            })[0];

          if (replacement) {
            items[idx] = { ...replacement, _tag: "마진하한보정" };
            fin = calcFinance(items, sale, fee);
            type = "전체 업그레이드";
            replaced = true;
            break;
          }
        }
        if (!replaced) break;
        guard += 1;
      }

      const chars = Array.from(new Set(items.flatMap((p) => splitMultiValues(p.char2)))).slice(0, 10).join(", ");

      if (fin.retailSum >= sale && isWithinMargin(fin, targetMargin)) {
        recs.push({ name: `추천안${recs.length + 1}`, type, items, finance: fin, chars });
      }
    }

    let out = recs;
    if (scoopRecType === "기본만") out = recs.filter((r) => r.type === "기본");
    if (scoopRecType === "부분 업그레이드만") out = recs.filter((r) => r.type === "부분 업그레이드");
    if (scoopRecType === "전체 업그레이드만") out = recs.filter((r) => r.type === "전체 업그레이드");

    if (scoopRecSort === "수량 적은 순") out = [...out].sort((a, b) => a.items.length - b.items.length);
    if (scoopRecSort === "수량 많은 순") out = [...out].sort((a, b) => b.items.length - a.items.length);
    if (scoopRecSort === "마진율 높은 순") out = [...out].sort((a, b) => b.finance.margin - a.finance.margin);
    if (scoopRecSort === "소비자가 높은 순") out = [...out].sort((a, b) => b.finance.retailSum - a.finance.retailSum);

    if (out.length === 0) {
      alert(`조건에 맞는 추천안이 없어요.\n소비자가합 ${money(sale)} 이상, 마진율 ${minMargin}%~${maxMargin}% 범위로 만들 수 있는 조합이 부족합니다.`);
      setScoopRecommendations([]);
      setSelectedScoopIndex(null);
      return;
    }

    setScoopRecommendations(out);
    setSelectedScoopIndex(0);
  }

  function sendScoopToCompose() {
    const rec = scoopRecommendations[selectedScoopIndex];
    if (!rec) return alert("추천안을 선택해줘.");
    setComposeItems(rec.items);
    setActiveTab("수동박스");
  }

  function replaceScoopItem(index) {
    const rec = scoopRecommendations[selectedScoopIndex];
    if (!rec) return;
    const old = rec.items[index];
    const pool = scoopCandidateProducts()
      .filter((p) => !rec.items.some((x) => x.id === p.id))
      .sort((a, b) => Math.abs(toInt(a.retail) - toInt(old.retail)) - Math.abs(toInt(b.retail) - toInt(old.retail)));
    const msg = pool.slice(0, 30).map((p) => `${p.id}: ${p.name} | 도매가 ${money(p.wholesale)} | 소비자가 ${money(p.retail)} | 카테고리 ${p.category}`).join("\n");
    const id = window.prompt(`교체할 상품 ID 입력\n\n${msg}`);
    if (!id) return;
    const picked = pool.find((p) => String(p.id) === String(id));
    if (!picked) return alert("상품 ID를 찾지 못했어요.");
    const next = [...scoopRecommendations];
    const items = [...rec.items];
    items[index] = picked;
    next[selectedScoopIndex] = { ...rec, items, finance: calcFinance(items, salePrice, feeRate) };
    setScoopRecommendations(next);
  }

  function removeScoopItem(index) {
    const rec = scoopRecommendations[selectedScoopIndex];
    if (!rec) return;
    const next = [...scoopRecommendations];
    const items = rec.items.filter((_, i) => i !== index);
    next[selectedScoopIndex] = { ...rec, items, finance: calcFinance(items, salePrice, feeRate) };
    setScoopRecommendations(next);
  }

  function showScoopGapRecommendations() {
    const rec = scoopRecommendations[selectedScoopIndex];
    if (!rec) return alert("추천안을 선택해줘.");
    const gap = Math.max(0, toInt(salePrice) - rec.finance.retailSum);
    const recChars = Array.from(new Set((rec.items || []).flatMap((p) => productCharacters(p))));

    let pool = scoopCandidateProducts().filter((p) => !rec.items.some((x) => x.id === p.id));

    if (scoopGapScope === "same") {
      pool = pool.filter((p) => hasSharedCharacter(recChars, p));
    }

    pool = pool
      .sort((a, b) => Math.abs(toInt(a.retail) - gap) - Math.abs(toInt(b.retail) - gap))
      .slice(0, 30);

    const title = scoopGapScope === "same" ? "같은 캐릭터 상품" : "모든 캐릭터 상품";
    alert(pool.length ? `[${title}]\\n부족금액: ${money(gap)}\\n\\n` + pool.map((p) => `${p.id}: ${p.name} | ${p.char1}/${p.char2} | 소비자가 ${money(p.retail)} | 도매가 ${money(p.wholesale)}`).join("\\n") : "추천할 상품이 없어요.");
  }

  async function createOrderFromScoop() {
    const rec = scoopRecommendations[selectedScoopIndex];
    if (!rec) return alert("추천안을 선택해줘.");
    await createOrderFromItems(rec.items, scoopCustomer, scoopMemo, scoopReorder, salePrice, feeRate);
  }


  function getStockZeroNamesForItems(items) {
    const count = {};
    items.forEach((p) => { count[p.id] = (count[p.id] || 0) + 1; });
    return Object.entries(count)
      .map(([id, qty]) => {
        const p = products.find((x) => String(x.id) === String(id));
        if (!p) return null;
        return toInt(p.stock) - qty === 0 ? p.name : null;
      })
      .filter(Boolean);
  }

  function recommendationCheckText(rec, type = "수동") {
    if (!rec) return "-";
    const sale = toInt(rec.saleTotal || salePrice || defaultSale);
    const bodyRetail = rec.bodyRetailSum || rec.finance?.retailSum || 0;
    const retailTarget = rec.retailTarget || sale;
    const targetMargin = Number(manualTargetMargin || scoopTargetMargin || 0);
    const min = rec.marginRangeText ? Number(String(rec.marginRangeText).split("%")[0]) : targetMargin;
    const max = rec.marginRangeText ? Number(String(rec.marginRangeText).split("~")[1]?.replace("%", "")) || targetMargin + 5 : targetMargin + 5;
    const zeroNames = getStockZeroNamesForItems(rec.items || []);
    return buildRecommendationCheck({
      type: rec.type || type,
      saleTotal: sale,
      retailTarget,
      bodyRetailSum: bodyRetail,
      totalRetailSum: rec.finance?.retailSum || 0,
      margin: rec.finance?.margin || 0,
      minMargin: min,
      maxMargin: max,
      giftName: rec.giftName || "",
      zeroStockNames: zeroNames,
    });
  }

  function FilterBox() {
    return (
      <>
        <div className="filterRow">
          <label>상품명</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="상품명 검색" />
          <MultiCheckFilter label="캐릭터1" options={char1Options} selected={char1Selected} setSelected={setChar1Selected} />
          <MultiCheckFilter label="캐릭터2" options={char2Options} selected={char2Selected} setSelected={setChar2Selected} />
          <label>카테고리</label>
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>{categoryOptions.map((v) => <option key={v}>{v}</option>)}</select>
          <label>가격대</label>
          <select value={priceFilter} onChange={(e) => setPriceFilter(e.target.value)}>{PRICE_RANGES.map((v) => <option key={v}>{v}</option>)}</select>
          <label>정렬</label>
          <select value={productSort} onChange={(e) => setProductSort(e.target.value)}>
            <option>기본순</option>
            <option>도매가 낮은순</option>
            <option>도매가 높은순</option>
            <option>소비자가 낮은순</option>
            <option>소비자가 높은순</option>
            <option>재고 많은순</option>
            <option>재고 적은순</option>
            <option>상품명순</option>
          </select>
          <button onClick={resetFilters}>초기화</button>
        </div>
        <label className="checkLine"><input checked={hiddenOnly} onChange={(e) => setHiddenOnly(e.target.checked)} type="checkbox" /> 히든템만 보기</label>
        <label className="checkLine"><input checked={excludeLowStock} onChange={(e) => setExcludeLowStock(e.target.checked)} type="checkbox" /> 재고 1개 제외</label>
        <p className="statusLine">조회 결과: {filteredProducts.length.toLocaleString()}종 / 재고 {filteredProducts.reduce((s, p) => s + toInt(p.stock), 0).toLocaleString()}개</p>
      </>
    );
  }

  function ProductTable({ mode }) {
    return (
      <div className="tableWrap">
        <table className="productTable">
          <thead><tr><th>ID</th><th>상품명</th><th>캐릭터1</th><th>캐릭터2</th><th>카테고리</th><th>재고</th><th>도매가</th><th>소비자가</th><th>히든</th><th>{mode === "compose" ? "추가" : "삭제"}</th></tr></thead>
          <tbody>
            {filteredProducts.map((p) => (
              <tr key={p.id} onClick={() => setSelectedProductId(p.id)} className={selectedProductId === p.id ? "selectedRow" : ""} title={p.name}>
                <td>{p.id}</td><td>{p.name}</td><td>{p.char1}</td><td>{p.char2}</td><td>{p.category}</td><td>{p.stock}</td><td>{money(p.wholesale)}</td><td>{money(p.retail)}</td><td>{p.hidden ? "Y" : ""}</td>
                <td>{mode === "compose" ? <button onClick={(e) => { e.stopPropagation(); addToCompose(p); }}>추가</button> : <button className="deleteBtn" onClick={(e) => { e.stopPropagation(); deleteProduct(p.id); }}>삭제</button>}</td>
              </tr>
            ))}
            {filteredProducts.length === 0 && <tr><td colSpan="10" className="empty">등록된 상품이 없어요.</td></tr>}
          </tbody>
        </table>
      </div>
    );
  }

  function DashboardPage() {
    return (
      <>
        <section className="cards">
          <div className="card"><span>상품종류</span><strong>{products.length.toLocaleString()}</strong></div>
          <div className="card"><span>재고수량</span><strong>{totalStock.toLocaleString()}</strong></div>
          <div className="card"><span>총매입가격</span><strong>{money(totalWholesale)}</strong></div>
          <div className="card"><span>총주문수</span><strong>{orders.filter((o) => o.status !== "취소").length.toLocaleString()}</strong></div>
          <div className="card"><span>총매출</span><strong>{money(totalSales)}</strong></div>
          <div className="card"><span>실수령액</span><strong>{money(totalNet)}</strong></div>
          <div className="card"><span>순이익</span><strong>{money(totalProfit)}</strong></div>
          <div className="card"><span>재료비</span><strong>{money(totalMaterials)}</strong></div>
        </section>
        <section className="panel">
          <h2>재료비 관리</h2>
          <div className="filterRow">
            <label>재료비명</label><input value={materialName} onChange={(e) => setMaterialName(e.target.value)} />
            <label>금액</label><input value={materialAmount} onChange={(e) => setMaterialAmount(e.target.value)} type="number" />
            <button onClick={addMaterial}>저장</button>
            <button className="deleteBtn" onClick={deleteMaterial}>삭제</button>
          </div>
          <div className="tableWrap smallTable">
            <table><thead><tr><th>ID</th><th>재료비명</th><th>금액</th></tr></thead><tbody>
              {materials.map((m) => <tr key={m.id} onClick={() => setSelectedMaterialId(m.id)} className={selectedMaterialId === m.id ? "selectedRow" : ""}><td>{m.id}</td><td>{m.name}</td><td>{money(m.amount)}</td></tr>)}
              {materials.length === 0 && <tr><td colSpan="3" className="empty">등록된 재료비가 없어요.</td></tr>}
            </tbody></table>
          </div>
        </section>
      </>
    );
  }

  function InventoryPage() {
    return (
      <>
        <section className="panel">
          <div className="filterRow">
            <input value={productForm.name} onChange={(e) => setProductForm({ ...productForm, name: e.target.value })} placeholder="상품명" />
            <input value={productForm.char1} onChange={(e) => setProductForm({ ...productForm, char1: e.target.value })} placeholder="캐릭터1" />
            <input value={productForm.char2} onChange={(e) => setProductForm({ ...productForm, char2: e.target.value })} placeholder="캐릭터2" />
            <input value={productForm.category} onChange={(e) => setProductForm({ ...productForm, category: e.target.value })} placeholder="카테고리" />
            <input value={productForm.stock} onChange={(e) => setProductForm({ ...productForm, stock: e.target.value })} placeholder="재고" />
            <input value={productForm.wholesale} onChange={(e) => setProductForm({ ...productForm, wholesale: e.target.value })} placeholder="도매가" />
            <input value={productForm.retail} onChange={(e) => setProductForm({ ...productForm, retail: e.target.value })} placeholder="소비자가" />
            <label className="checkLine"><input checked={productForm.hidden} onChange={(e) => setProductForm({ ...productForm, hidden: e.target.checked })} type="checkbox" /> 히든</label>
            <button onClick={addProduct}>상품 저장</button>
          </div>
        </section>
        <section className="panel">
          <FilterBox />
          <div className="buttonRow">
            <label className="uploadBtn">엑셀 불러오기<input type="file" accept=".xlsx,.xls,.csv" onChange={handleExcelUpload} /></label>
            <button onClick={downloadInventoryExcel}>현재 재고 엑셀</button>
            <button onClick={downloadCurrentInventoryBackupFile}>재고 백업 파일</button>
            <button onClick={() => createInventoryBackup("manual_backup").then((ok) => ok && alert("재고 백업 완료!"))}>DB 백업 저장</button>
            <button onClick={restoreLatestInventoryBackup}>최근 백업 복구</button>
            <button onClick={showBackupListAndRestore}>백업 목록 선택복구</button>
            <button onClick={showChar2Values}>캐릭터2 목록 확인</button>
            <button onClick={showCharacterShortage}>부족 캐릭터 보기</button>
            <button className="deleteBtn" onClick={() => deleteProduct(selectedProductId)}>상품 삭제</button>
          </div>
          <ProductTable mode="inventory" />
        </section>
      </>
    );
  }

  function ComposePage() {
    const selectedManual = manualRecommendations[selectedManualIndex];
    return (
      <>
        <section className="panel"><FilterBox /></section>
        <section className="splitLayout">
          <div className="panel">
            <h2>조건 상품 리스트</h2>
            <ProductTable mode="compose" />
          </div>
          <div className="panel">
            <h2>현재 조합 리스트</h2>
            <div className="tableWrap composeNow">
              <table><thead><tr><th>상품ID</th><th>상품명</th><th>재고</th><th>도매가</th><th>소비자가</th><th>삭제</th></tr></thead><tbody>
                {composeItems.map((p, i) => <tr key={`${p.id}-${i}`}><td>{p.id}</td><td title={p.name}>{p.name}</td><td>{p.stock}</td><td>{money(p.wholesale)}</td><td>{money(p.retail)}</td><td><button className="deleteBtn" onClick={() => setComposeItems(composeItems.filter((_, idx) => idx !== i))}>삭제</button></td></tr>)}
                {composeItems.length === 0 && <tr><td colSpan="6" className="empty">아직 조합한 상품이 없어요.</td></tr>}
              </tbody></table>
            </div>
            <div className="filterRow calcRow">
              <label>판매가</label><input value={salePrice} onChange={(e) => setSalePrice(e.target.value)} />
              <label>수수료율</label><input value={feeRate} onChange={(e) => setFeeRate(e.target.value)} />
              <label>주문자명</label><input value={customer} onChange={(e) => setCustomer(e.target.value)} />
              <label className="checkLine"><input checked={reorder} onChange={(e) => setReorder(e.target.checked)} type="checkbox" /> 재주문</label>
              <label>메모</label><input value={memo} onChange={(e) => setMemo(e.target.value)} />
              <button onClick={clearCompose}>주문초기화</button>
              <button onClick={createOrderFromCompose}>박스출고</button>
            </div>
            <p className="statusLine">도매가합 {money(finance.wholesaleSum)} | 소비자가합 {money(finance.retailSum)} | 수수료 {money(finance.feeAmount)} | 실수령액 {money(finance.netAmount)} | 순이익 {money(finance.profit)} | 마진율 {finance.margin.toFixed(1)}%</p>

            <div className="subPanel">
              <h2>수동박스 추천안</h2>
              <div className="filterRow">
                <label>유형</label><select value={manualType} onChange={(e) => setManualType(e.target.value)}><option>소확행</option><option>프리미엄박스</option><option>히든박스</option></select>
                <label>박스수</label><input value={manualBoxCount} onChange={(e) => setManualBoxCount(e.target.value)} />
                <label>목표마진율</label><input value={manualTargetMargin} onChange={(e) => setManualTargetMargin(e.target.value)} />
                <label>판매가 대비 추가 소비자가</label><input value={manualRetailExtra} onChange={(e) => setManualRetailExtra(e.target.value)} placeholder="예: 20000" title="판매가에 더해서 원하는 추가 소비자가를 입력해요. 예: 판매가 50000 + 20000 = 본품 소비자가 70000 이상" />
                <label>히든절감%</label><input value={manualHiddenDiscount} onChange={(e) => setManualHiddenDiscount(e.target.value)} disabled title="v16부터 히든박스 특수 기준은 사용하지 않아요." />
                <label>구성</label><select value={manualStyle} onChange={(e) => setManualStyle(e.target.value)}><option>선택안함</option><option>자잘자잘</option><option>믹스</option><option>큼직큼직</option></select>
                <MultiCheckFilter label="선호 캐릭터1" options={char1Options} selected={manualPrefChar1} setSelected={setManualPrefChar1} />
                <MultiCheckFilter label="선호 캐릭터2" options={char2Options} selected={manualPrefChar2} setSelected={setManualPrefChar2} />
              </div>
              <div className="buttonRow">
                <button onClick={generateManualRecommendations}>추천안 생성</button>
                <button onClick={applyManualRecommendation}>추천안 → 현재조합</button>
                <button onClick={showCharacterBoxCapacity}>캐릭터별 가능 박스 수</button>
                <button onClick={manualGapRecommendations}>부족 금액 추천 보기</button>
                <button onClick={addManualGapItem}>부족 상품 추가</button>
                <button onClick={addSelectedProductToManualRecommendation}>선택상품 추천안에 추가</button>
              </div>
              <div className="tableWrap recommendationTable">
                <table><thead><tr><th>추천안</th><th>유형</th><th>박스수</th><th>포함 캐릭터</th><th>도매가합</th><th>소비자가합</th><th>순이익</th><th>마진율</th><th>선호반영</th><th>본품부족/초과</th><th>설명</th><th>겹침</th><th>검증</th></tr></thead><tbody>
                  {manualRecommendations.map((r, i) => <tr key={i} onClick={() => setSelectedManualIndex(i)} className={selectedManualIndex === i ? "selectedRow" : ""}><td>{r.name}</td><td>{r.type}</td><td>{r.boxCount}</td><td>{r.chars}</td><td>{money(r.finance.wholesaleSum)}</td><td>{money(r.finance.retailSum)}</td><td>{money(r.finance.profit)}</td><td>{r.finance.margin.toFixed(1)}%</td><td>{money(-r.retailGap)}</td><td>{r.note}</td><td>{r.diversityText || "-"}</td><td>{recommendationCheckText(r, r.type)}</td></tr>)}
                  {manualRecommendations.length === 0 && <tr><td colSpan="12" className="empty">추천안을 생성해줘.</td></tr>}
                </tbody></table>
              </div>
              <h3>추천안 상품 목록</h3>
              {selectedManual && <p className="validationLine">{recommendationCheckText(selectedManual, selectedManual.type)}</p>}
              {selectedManual && <p className="statusLine">판매가 {money(selectedManual.saleTotal)} | 본품 목표 {money(selectedManual.retailTarget || selectedManual.saleTotal)} | 본품 소비자가합 {money(selectedManual.bodyRetailSum || selectedManual.finance.retailSum)} | 마진허용 {selectedManual.marginRangeText || "-"} | 총 소비자가합 {money(selectedManual.finance.retailSum)} | 🎁 랜덤선물 {selectedManual.giftName || "-"} | 도매가합 {money(selectedManual.finance.wholesaleSum)} | 수수료 {money(selectedManual.finance.feeAmount)} | 실수령액 {money(selectedManual.finance.netAmount)} | 순이익 {money(selectedManual.finance.profit)} | 마진율 {selectedManual.finance.margin.toFixed(1)}%</p>}
              <div className="filterRow">
                <label>주문자명</label><input value={manualCustomer} onChange={(e) => setManualCustomer(e.target.value)} />
                <label className="checkLine"><input checked={manualReorder} onChange={(e) => setManualReorder(e.target.checked)} type="checkbox" /> 재주문</label>
                <label>메모</label><input value={manualMemo} onChange={(e) => setManualMemo(e.target.value)} />
                <button onClick={createOrderFromManualRecommendation}>선택 추천안 출고</button>
              </div>
              <div className="tableWrap recItems">
                <table><thead><tr><th>ID</th><th>상품명</th><th>캐릭터1</th><th>캐릭터2</th><th>카테고리</th><th>도매가</th><th>소비자가</th><th>구분</th><th>삭제</th></tr></thead><tbody>
                  {(selectedManual?.items || []).map((p, i) => <tr key={`${p.id}-${i}`} className={p._tag === "랜덤선물" ? "giftRow" : ""}><td>{p.id}</td><td title={p.name}>{p.name}</td><td>{p.char1}</td><td>{p.char2}</td><td>{p.category}</td><td>{money(p.wholesale)}</td><td>{money(p.retail)}</td><td>{p._tag || "본품"}</td><td><button className="deleteBtn" onClick={() => removeManualRecommendationItem(i)}>삭제</button></td></tr>)}
                  {!selectedManual && <tr><td colSpan="9" className="empty">추천안을 선택해줘.</td></tr>}
                </tbody></table>
              </div>
            </div>
          </div>
        </section>
      </>
    );
  }


  async function deleteSavedScoopGroup(groupId) {
    if (!groupId) return alert("삭제할 저장 그룹을 선택해줘.");
    if (!window.confirm("저장된 그룹을 삭제할까요? 삭제 후 되돌릴 수 없어요.")) return;
    const { error } = await supabase.from("saved_scoop_groups").delete().eq("id", groupId);
    if (error) return alert("저장 그룹 삭제 실패: " + error.message);
    alert("저장된 그룹을 삭제했어요.");
    getSavedScoopGroups?.();
    loadSavedScoopGroups?.();
  }

  function ScoopPage() {
    const selected = scoopRecommendations[selectedScoopIndex];
    return (
      <>
        <section className="panel scoopTop">
          <div className="filterRow">
            <label>그룹수</label><input value={scoopGroupCount} onChange={(e) => setScoopGroupCount(e.target.value)} />
            <label>분배기준</label><select value={scoopMode} onChange={(e) => setScoopMode(e.target.value)}><option>상품 수 균등</option><option>소비자가 균등</option><option>도매가 균등</option><option>혼합 균형</option><option>카테고리 자동</option></select>
            <MultiCheckFilter label="캐릭터1" options={char1Options} selected={scoopChar1Selected} setSelected={setScoopChar1Selected} />
            <MultiCheckFilter label="캐릭터2" options={char2Options} selected={scoopChar2Selected} setSelected={setScoopChar2Selected} />
            <label>가격대</label><select value={scoopPrice} onChange={(e) => setScoopPrice(e.target.value)}>{PRICE_RANGES.map((v) => <option key={v}>{v}</option>)}</select>
            <label>소비자가상한</label><input value={scoopRetailLimit} onChange={(e) => setScoopRetailLimit(e.target.value)} />
            <button onClick={analyzeScoopCategories}>카테고리 자동 분석</button>
            <button onClick={generateScoopGroups}>그룹 나누기</button>
            <button onClick={saveScoopGroups}>그룹 저장</button>
            <button onClick={loadScoopGroups}>저장된 그룹 열기</button>
            <button onClick={sendScoopToCompose}>현재 조합으로 보내기</button>
          </div>
        </section>

        <section className="scoopOriginalGrid">
          <div className="panel scoopLeftPanel">
            <h2>1단계: 카테고리 후보 설정 / 분석</h2>
            <p className="statusLine">사용 가능 상품 수 {scoopCategoryStats.reduce((s, x) => s + toInt(x.count), 0).toLocaleString()}개 | 배제된 상품 수 {scoopExcludedCount.toLocaleString()}개</p>
            <textarea className="analysisBox" value={scoopAnalysisText} readOnly />
            <h3>카테고리 목록</h3>
            <div className="tableWrap categoryStatsTable">
              <table>
                <thead><tr><th>선택</th><th>카테고리</th><th>총재고</th><th>평균 소비자가</th></tr></thead>
                <tbody>
                  {scoopCategoryStats.map((s) => <tr key={s.category}><td><input type="checkbox" checked={scoopSelectedCategories.includes(s.category)} onChange={() => toggleScoopCategory(s.category)} /></td><td>{s.category}</td><td>{s.stockSum}</td><td>{money(s.avgRetail)}</td></tr>)}
                  {scoopCategoryStats.length === 0 && <tr><td colSpan="4" className="empty">카테고리 자동 분석을 눌러줘.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="buttonRow">
              <button onClick={makeManualCategoryGroup}>선택 카테고리 묶기</button>
            </div>
          </div>

          <div className="panel scoopMiddlePanel">
            <h2>2단계: 그룹 확인 / 수정</h2>
            <div className="tableWrap groupTable">
              <table>
                <thead><tr><th>그룹명</th><th>카테고리</th><th>총재고</th><th>평균소비자가</th><th>묶인 이유</th></tr></thead>
                <tbody>
                  {scoopGroups.map((g) => <tr key={g.id}><td>{g.name}</td><td>{(g.categories || []).join(", ")}</td><td>{g.stock}</td><td>{money(g.avgRetail)}</td><td>{g.reason}</td></tr>)}
                  {scoopGroups.length === 0 && <tr><td colSpan="5" className="empty">그룹이 없어요.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="buttonRow">
              <button onClick={() => {
                const id = window.prompt("수정할 그룹 번호를 입력해줘. 예: 1");
                if (!id) return;
                renameScoopGroup(toInt(id));
              }}>그룹 이름 수정</button>
            </div>
          </div>

          <div className="panel scoopRightPanel">
            <h2>3단계: 파츠 설계 / 4단계: 결과 보기</h2>
            <div className="filterRow">
              <label>판매가</label><input value={salePrice} onChange={(e) => setSalePrice(e.target.value)} />
              <label>수수료율</label><input value={feeRate} onChange={(e) => setFeeRate(e.target.value)} />
              <label>목표마진율</label><input value={scoopTargetMargin} onChange={(e) => setScoopTargetMargin(e.target.value)} />
              <label>추천유형</label><select value={scoopRecType} onChange={(e) => setScoopRecType(e.target.value)}><option>전체 보기</option><option>기본만</option><option>부분 업그레이드만</option><option>전체 업그레이드만</option></select>
              <label>추천순서</label><select value={scoopRecSort} onChange={(e) => setScoopRecSort(e.target.value)}><option>추천순</option><option>수량 적은 순</option><option>수량 많은 순</option><option>마진율 높은 순</option><option>소비자가 높은 순</option></select>
              <div className="scoopPrefBox">
                <span className="smallLabel">선호 캐릭터</span>
                <MultiCheckFilter label="캐릭터1" options={char1Options} selected={scoopChar1Selected} setSelected={setScoopChar1Selected} />
                <MultiCheckFilter label="캐릭터2" options={char2Options} selected={scoopChar2Selected} setSelected={setScoopChar2Selected} />
              </div>
              <button onClick={generateScoopRecommendations}>추천안 생성</button>
            </div>

            <h3>그룹별 파츠 개수</h3>
            <div className="partsArea">
              <div className="tableWrap partsTable">
                <table>
                  <thead><tr><th>그룹명</th><th>파츠 개수</th></tr></thead>
                  <tbody>
                    {scoopGroups.map((g) => <tr key={g.id} onClick={() => {}}>
                      <td>{g.name}</td>
                      <td><input className="tinyInput" value={g.partQty} onChange={(e) => updateScoopPartQty(g.id, e.target.value)} /> 개 (추천 {g.partPercent || 0}%)</td>
                    </tr>)}
                    {scoopGroups.length === 0 && <tr><td colSpan="2" className="empty">그룹이 없어요.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>

            <h3>추천안 목록</h3>
            <div className="tableWrap recommendationTable">
              <table><thead><tr><th>추천안</th><th>업그레이드</th><th>포함 캐릭터</th><th>총 도매가</th><th>총 소비자가</th><th>수수료</th><th>실수령액</th><th>순이익</th><th>마진율</th></tr></thead><tbody>
                {scoopRecommendations.map((r, i) => <tr key={i} onClick={() => setSelectedScoopIndex(i)} className={selectedScoopIndex === i ? "selectedRow" : ""}><td>{r.name}</td><td>{r.type}</td><td>{r.chars}</td><td>{money(r.finance.wholesaleSum)}</td><td>{money(r.finance.retailSum)}</td><td>{money(r.finance.feeAmount)}</td><td>{money(r.finance.netAmount)}</td><td>{money(r.finance.profit)}</td><td>{r.finance.margin.toFixed(1)}%</td><td>{r.prefNote || scoopPreferenceNote(r.items)}</td></tr>)}
                {scoopRecommendations.length === 0 && <tr><td colSpan="10" className="empty">추천안이 없어요.</td></tr>}
              </tbody></table>
            </div>

            <h3>추천안 상품 목록 (교체 / 추가·삭제 가능)</h3>
            <div className="buttonRow">
              <select value={scoopGapScope} onChange={(e) => setScoopGapScope(e.target.value)} title="부족금액 추천 범위"><option value="same">같은 캐릭터 상품만 보기</option><option value="all">모든 캐릭터 보기</option></select>
              <button onClick={showScoopGapRecommendations}>부족 금액 추천 보기</button>
              <input value={scoopCustomer} onChange={(e) => setScoopCustomer(e.target.value)} placeholder="주문자명" />
              <label className="checkLine"><input checked={scoopReorder} onChange={(e) => setScoopReorder(e.target.checked)} type="checkbox" /> 재주문</label>
              <input value={scoopMemo} onChange={(e) => setScoopMemo(e.target.value)} placeholder="메모" />
              <button onClick={createOrderFromScoop}>박스출고</button>
            </div>
            <div className="tableWrap recItems">
              <table><thead><tr><th>ID</th><th>상품명</th><th>그룹/카테고리</th><th>도매가</th><th>소비자가</th><th>교체</th><th>삭제</th></tr></thead><tbody>
                {(selected?.items || []).map((p, i) => <tr key={`${p.id}-${i}`}><td>{p.id}</td><td title={p.name}>{p.name}</td><td>{p.category}</td><td>{money(p.wholesale)}</td><td>{money(p.retail)}</td><td><button onClick={() => replaceScoopItem(i)}>교체</button></td><td><button className="deleteBtn" onClick={() => removeScoopItem(i)}>삭제</button></td></tr>)}
                {!selected && <tr><td colSpan="7" className="empty">추천안을 선택해줘.</td></tr>}
              </tbody></table>
            </div>
            {selected && <p className="validationLine">{recommendationCheckText(selected, selected.type)}</p>}
            {selected && <p className="statusLine">도매가합 {money(selected.finance.wholesaleSum)} | 소비자가합 {money(selected.finance.retailSum)} | 수수료 {money(selected.finance.feeAmount)} | 실수령액 {money(selected.finance.netAmount)} | 순이익 {money(selected.finance.profit)} | 마진율 {selected.finance.margin.toFixed(1)}%</p>}
          </div>
        </section>
      </>
    );
  }


  async function restoreCanceledOrderFromTrash(orderId) {
    alert("취소된 주문은 출고상태로 복구할 수 없어요. 필요하면 같은 상품으로 새 주문을 다시 만들어주세요.");
  }

  async function permanentlyDeleteOrder(orderId) {
    const order = orders.find((o) => o.id === orderId);
    if (!order) return alert("주문을 찾을 수 없어요.");
    if (!order.deleted_at) return alert("취소보관함 주문만 영구삭제할 수 있어요.");

    const ok = window.confirm(
      `주문ID ${orderId}를 영구삭제할까요?\n\n` +
      "영구삭제하면 주문 기록과 주문상품 기록이 완전히 삭제됩니다.\n" +
      "재고는 이미 취소 시 복구되었으므로 여기서는 재고 변화가 없습니다."
    );
    if (!ok) return;

    await supabase.from("order_items").delete().eq("order_id", orderId);
    const { error } = await supabase.from("orders").delete().eq("id", orderId);
    if (error) return alert("영구삭제 실패: " + error.message);

    await writeAudit("order_permanent_delete", `order_id=${orderId}`);
    alert("영구삭제 완료!");
    getOrders();
    getOrderItems();
  }

  function OrderTable({ title, rows }) {
    return (
      <div className="orderBox">
        <h3>{title}</h3>
        <div className="tableWrap">
          <table><thead><tr><th>주문ID</th><th>주문일</th><th>주문자</th><th>재주문</th><th>상태</th><th>판매가</th><th>실수령액</th><th>순이익</th><th>취소사유</th></tr></thead><tbody>
            {rows.map((o) => <tr key={o.id} onClick={() => setSelectedOrderId(o.id)} className={selectedOrderId === o.id ? "selectedRow" : ""}><td>{o.id}</td><td>{String(o.created_at || "").replace("T", " ").slice(0, 19)}</td><td>{o.customer}</td><td>{toInt(o.reorder) === 1 ? "Y" : ""}</td><td>{o.status}</td><td>{money(o.sale_price)}</td><td>{money(o.net_amount)}</td><td>{money(o.profit)}</td><td>{o.cancel_reason || ""}</td></tr>)}
            {rows.length === 0 && <tr><td colSpan="9" className="empty">표시할 주문이 없어요.</td></tr>}
          </tbody></table>
        </div>
      </div>
    );
  }

  function OrdersPage() {
    return (
      <>
        <section className="panel">
          <div className="filterRow">
            <label>주문자명</label><input value={orderSearchCustomer} onChange={(e) => setOrderSearchCustomer(e.target.value)} />
            <label>주문일</label><input value={orderSearchDate} onChange={(e) => setOrderSearchDate(e.target.value)} placeholder="YYYY-MM-DD" />
            <label className="checkLine"><input checked={orderReorderOnly} onChange={(e) => setOrderReorderOnly(e.target.checked)} type="checkbox" /> 재구매자만</label>
            <button onClick={getOrders}>검색</button>
            <button onClick={() => { setOrderSearchCustomer(""); setOrderSearchDate(""); setOrderReorderOnly(false); setSelectedOrderId(null); }}>초기화</button>
            <button onClick={shipSelectedOrder}>출고확정</button>
            <button className="deleteBtn" onClick={cancelSelectedOrder}>주문취소</button>
            <button onClick={showSelectedOrderItems}>주문상품보기</button>
            <button onClick={() => selectedOrderId ? copyOrderToManualComposition(selectedOrderId) : alert("복사할 주문을 선택해줘.")}>구성복사 수동박스</button>
            <button onClick={downloadOrdersExcel}>주문 엑셀</button>
            <button onClick={downloadCustomerOrderExcel}>고객용 엑셀</button>
          </div>
          <p className="statusLine">선택된 주문ID: {selectedOrderId || "-"}</p>
        </section>
        <section className="ordersGrid"><OrderTable title="주문접수 / 재고임시차감" rows={pendingOrders} /><OrderTable title="출고확정 / 발송완료" rows={shippedOrders} /></section>
        <section className="panel orderDetailPanel">
          <h2>선택 주문 상품 목록</h2>
          <div className="tableWrap">
            <table>
              <thead><tr><th>상품ID</th><th>상품명</th><th>수량</th><th>도매가</th><th>소비자가</th></tr></thead>
              <tbody>
                {selectedOrderItems.map((x) => <tr key={x.id}><td>{x.product_id}</td><td title={x.name}>{x.name}</td><td>{x.qty}</td><td>{money(x.wholesale)}</td><td>{money(x.retail)}</td></tr>)}
                {selectedOrderItems.length === 0 && <tr><td colSpan="5" className="empty">주문을 선택하고 주문상품보기를 눌러줘.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </>
    );
  }


  async function copyOrderToManualComposition(orderId) {
    const oldOrder = orders.find((o) => o.id === orderId);
    if (!oldOrder) return alert("주문을 찾을 수 없어요.");

    const rows = orderItems.filter((x) => x.order_id === orderId);
    if (rows.length === 0) return alert("복사할 주문상품이 없어요.");

    const copiedItems = [];
    const missing = [];
    const shortage = [];

    for (const x of rows) {
      const p = products.find((prod) => String(prod.id) === String(x.product_id));
      if (!p) {
        missing.push(`${x.name || "상품명 없음"} / 상품ID ${x.product_id}`);
        continue;
      }

      const qty = toInt(x.qty || 1);
      if (toInt(p.stock) < qty) {
        shortage.push(`${p.name} | 필요 ${qty}개 / 현재 ${p.stock}개`);
      }

      for (let i = 0; i < qty; i++) {
        copiedItems.push(p);
      }
    }

    if (missing.length > 0) {
      alert(
        "현재 재고 목록에서 찾을 수 없는 상품이 있어요.\n" +
        "삭제된 상품은 수동박스 조합으로 복사할 수 없어요.\n\n" +
        missing.join("\n")
      );
      return;
    }

    if (shortage.length > 0) {
      alert(
        "복사하려는 구성 중 현재 재고가 부족한 상품이 있어요.\n" +
        "수동박스로 복사하지 않았습니다.\n\n" +
        shortage.join("\n")
      );
      return;
    }

    const ok = window.confirm(
      `주문ID ${orderId}의 구성을 수동박스 현재 조합 리스트로 복사할까요?\n\n` +
      `상품 수: ${copiedItems.length}개\n` +
      `주문자명: ${oldOrder.customer || ""}\n` +
      `판매가: ${money(oldOrder.sale_price)}\n\n` +
      "복사 후 수동박스 화면에서 상품 목록을 확인하고 박스출고를 눌러야 새 주문이 생성됩니다."
    );
    if (!ok) return;

    setComposeItems(copiedItems);
    setCustomer(oldOrder.customer || "");
    setReorder(toInt(oldOrder.reorder) === 1);
    setMemo(`주문ID ${orderId} 구성 복사`);
    setSalePrice(String(toInt(oldOrder.sale_price || salePrice || defaultSale)));
    setFeeRate(String(oldOrder.fee_rate ?? feeRate ?? defaultFee));

    setActiveTab("수동박스");
    alert("구성 복사 완료!\n수동박스의 현재 조합 리스트에서 확인한 뒤 박스출고를 눌러주세요.");
  }

  function TrashPage() {
    return (
      <section className="panel trashPage">
        <h2>취소보관함</h2>
        <p className="statusLine">취소된 주문은 30일 보관용으로 표시됩니다. 재고는 취소 시 이미 복구됩니다.</p>
        <div className="tableWrap trashTable">
          <table>
            <thead>
              <tr>
                <th>주문ID</th><th>주문자</th><th>취소사유</th><th>메모</th><th>취소일</th><th>보관 남은일</th><th>판매가</th><th>순이익</th><th>수동박스복사</th><th>영구삭제</th>
              </tr>
            </thead>
            <tbody>
              {trashOrders.map((o) => (
                <tr key={o.id}>
                  <td>{o.id}</td>
                  <td>{o.customer}</td>
                  <td>{o.cancel_reason || "-"}</td>
                  <td>{o.cancel_detail || ""}</td>
                  <td>{o.deleted_at || o.canceled_at || "-"}</td>
                  <td>{daysLeftForTrash(o)}일</td>
                  <td>{money(o.sale_price)}</td>
                  <td>{money(o.profit)}</td>
                  <td><button onClick={() => copyOrderToManualComposition(o.id)}>수동박스로 복사</button></td>
                  <td><button className="deleteBtn" onClick={() => permanentlyDeleteOrder(o.id)}>영구삭제</button></td>
                </tr>
              ))}
              {trashOrders.length === 0 && <tr><td colSpan="10" className="empty">취소보관함이 비어 있어요.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  function SettingsPage() {
    return (
      <section className="manualPage">
        <h2>사용 설명서</h2>

        <div className="manualGrid">
          <div className="manualCard">
            <h3>1. 재고관리</h3>
            <p>상품을 직접 추가하거나 엑셀을 불러와 재고를 등록합니다.</p>
            <p><b>엑셀 불러오기</b>는 기존 재고 전체 교체 또는 추가 등록을 선택할 수 있습니다.</p>
            <p>캐릭터1/캐릭터2는 여러 개 선택 검색이 가능하고, 도매가/소비자가/재고순 정렬로 볼 수 있습니다.</p>
          </div>

          <div className="manualCard">
            <h3>2. 수동박스</h3>
            <p>왼쪽 조건 상품 리스트에서 상품을 추가하면 오른쪽 현재 조합 리스트에 담깁니다.</p>
            <p>판매가, 수수료율, 주문자명, 재주문 여부, 메모를 입력하고 <b>박스출고</b>를 누르면 주문이 등록되고 재고가 차감됩니다.</p>
            <p>아래 <b>수동박스 추천안</b>에서는 프리미엄/소확행/히든박스, 박스수, 목표마진율, 구성 느낌을 기준으로 추천안을 만들 수 있습니다.</p>
            <p>추천안 상품은 직접 추가/삭제할 수 있고, 수정하면 도매가합/소비자가합/수수료/실수령액/순이익/마진율이 즉시 다시 계산됩니다.</p>
          </div>

          <div className="manualCard">
            <h3>3. 랜덤스쿱</h3>
            <p>카테고리 자동 분석 또는 그룹 나누기로 파츠 그룹을 만듭니다.</p>
            <p>그룹별 파츠 수를 조정한 뒤 추천안 생성을 누르면 판매가, 수수료율, 목표마진율 기준으로 스쿱 추천안이 만들어집니다.</p>
            <p>추천안 상품은 교체/삭제가 가능하고, 부족 금액 추천 보기로 소비자가 부족분에 맞는 상품을 찾을 수 있습니다.</p>
            <p>주문자명과 재주문 여부를 입력하고 박스출고하면 주문관리로 이동하며, 이때 재고가 임시차감됩니다.</p>
          </div>

          <div className="manualCard">
            <h3>4. 주문관리</h3>
            <p>주문접수/미출고와 출고확정/발송완료를 나눠서 봅니다.</p>
            <p>주문을 선택한 뒤 출고확정 또는 주문취소를 누를 수 있습니다.</p>
            <p>박스출고/주문생성 시 재고가 임시차감되고, 주문취소 시 주문접수건/출고확정건 모두 재고가 복구됩니다. 출고확정은 추가 차감 없이 상태만 출고완료로 바뀝니다.</p>
            <p>취소보관함에서 취소된 주문의 구성을 복사해 새 주문으로 다시 만들 수 있습니다.</p>
          </div>

          <div className="manualCard">
            <h3>5. 실시간 동기화</h3>
            <p>같은 Supabase 프로젝트를 사용하는 PC/휴대폰에서는 재고, 주문, 재료비 변경이 실시간으로 반영됩니다.</p>
            <p>반영이 늦으면 새로고침하거나 인터넷 연결을 확인하세요.</p>
          </div>

          <div className="manualCard">
            <h3>6. 주의사항</h3>
            <p>추천안은 검증 표시를 확인하고 출고하세요. 소비자가/마진/마지막 재고 여부가 표시됩니다.</p>
            <p>엑셀 불러오기 전 재고는 자동 백업되며, 재고관리에서 최근 백업 복구와 백업 목록 선택복구가 가능합니다.</p>
            <p>출고 전 최종 확인창에서 소비자가합, 순이익, 마진율, 마지막 재고 상품을 확인할 수 있습니다.</p>
            <p>긴 상품명은 화면에서는 줄여 보이고, 마우스를 올리면 전체 이름을 확인할 수 있습니다.</p>
          </div>

          <div className="manualCard">
            <h3>7. 원본과 맞춘 부분</h3>
            <p>캐릭터 선택은 원본처럼 별도 선택창 방식으로 열립니다.</p>
            <p>랜덤스쿱은 카테고리 분석, 그룹 묶기 확인, 묶인 이유, 파츠 수, 추천안, 추천안 상품 목록 순서로 진행합니다.</p>
            <p>카테고리 목록에서 여러 카테고리를 체크하고 선택 카테고리 묶기를 누르면 수동 그룹을 만들 수 있습니다.</p>
          </div>
        </div>
      </section>
    );
  }


  async function handleLoginSubmit(e) {
    e.preventDefault();
    setLoginError("");

    if (!loginPassword.trim()) {
      setLoginError("비밀번호를 입력해줘.");
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({
      email: ADMIN_EMAIL,
      password: loginPassword,
    });

    if (error) {
      setLoginPassword("");
      setLoginError("비밀번호가 맞지 않아요.");
      return;
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setAuthUser(null);
    setProducts([]);
    setOrders([]);
    setOrderItems([]);
    setMaterials([]);
  }

  function AuthScreen() {
    return (
      <div className="authPage">
        <form className="authBox" onSubmit={handleLoginSubmit}>
          <h1>랜덤박스 운영 프로그램</h1>
          <p>관리자 비밀번호를 입력해야 재고/주문 데이터를 볼 수 있어요.</p>

          <input type="text" name="fake-user" autoComplete="username" style={{ display: "none" }} />
          <label>관리자 비밀번호</label>
          <input
            type="password"
            name="randombox-admin-pass"
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            placeholder="비밀번호"
            autoFocus
            autoComplete="new-password"
            spellCheck="false"
          />

          {loginError && <div className="authError">{loginError}</div>}

          <button type="submit">들어가기</button>


        </form>
      </div>
    );
  }

  function renderPage() {
    if (activeTab === "대시보드") return DashboardPage();
    if (activeTab === "재고관리") return InventoryPage();
    if (activeTab === "수동박스") return ComposePage();
    if (activeTab === "랜덤스쿱") return ScoopPage();
    if (activeTab === "주문관리") return OrdersPage();
    if (activeTab === "취소보관함") return TrashPage();
    if (activeTab === "설정") return SettingsPage();
    return DashboardPage();
  }

  if (authLoading) {
    return <div className="authPage"><div className="authBox"><h1>확인 중...</h1></div></div>;
  }

  if (!authUser) {
    return AuthScreen();
  }

  return (
    <div className="app">
      <header className="header">
        <h1>랜덤박스 운영 프로그램</h1>
        <div className="loginInfo">
          <span>관리자 로그인 중</span>
          <button onClick={handleLogout}>로그아웃</button>
        </div>
      </header>
      <nav className="tabs">{TABS.map((tab) => <button key={tab} className={activeTab === tab ? "tab activeTab" : "tab"} onClick={() => setActiveTab(tab)}>{tab}</button>)}</nav>
      {renderPage()}
    </div>
  );
}
