
랜덤박스 웹앱 all features v25-copy-to-manual

v25 수정:
- 주문복사 방식 변경
  기존: 주문복사 버튼 클릭 시 바로 새 주문 생성
  변경: 주문복사 버튼 클릭 시 수동박스의 '현재 조합 리스트'로 복사

동작:
1. 취소보관함 또는 주문관리에서 '수동박스로 복사' 클릭
2. 현재 재고에서 해당 상품이 존재하는지 확인
3. 현재 재고가 부족하면 복사 차단 + 부족 상품 목록 표시
4. 문제가 없으면 수동박스 화면으로 이동
5. 현재 조합 리스트에 복사된 상품 표시
6. 주문자명/재구매/판매가/수수료/메모도 기존 주문 기준으로 채움
7. 사용자가 직접 확인 후 박스출고를 눌러 새 주문 생성
8. 박스출고 시점에 재고가 임시차감됨

적용:
1. src/App.jsx 교체
2. src/App.css 교체
3. SQL은 v23 이후 실행했다면 다시 실행하지 않아도 됩니다.
4. Ctrl + F5


배포용 전체 프로젝트입니다. GitHub에는 이 압축을 풀어서 나온 전체 파일을 올려주세요.


v29 안정화:
- 랜덤스쿱 페이지가 안 보이는 문제를 피하기 위해 v25 안정버전 기준으로 복구
- 모바일에서도 데스크톱 웹 화면 그대로 보이게 CSS 강제
- 랜덤스쿱 부족금액 추천에 같은 캐릭터/모든 캐릭터 선택 추가


v30 수정:
- 랜덤스쿱 3단계 추천안 생성 전 선호 캐릭터1/2 체크 선택 영역 추가
- 선택 캐릭터를 우선 반영하고, 부족하면 경고 및 다른 캐릭터가 섞일 수 있게 처리
- 추천안 표에 선호 캐릭터 반영/부족/다른 캐릭터 섞임 여부 표시
- 부족금액 추천 범위 선택 추가: 같은 캐릭터 상품만 보기 / 모든 캐릭터 보기
- 저장된 랜덤스쿱 그룹 삭제 버튼 추가
- 모바일도 데스크톱 웹 화면 그대로 보이게 유지


v31: 빌드 오류 원인이던 중복 함수(productCharacters/hasSharedCharacter 등)를 제거했습니다.


v32: hasSharedCharacter 함수의 괄호 오타로 인한 빌드 오류를 수정했습니다.


v33 수정:
- 랜덤스쿱 저장 그룹 삭제 기능을 확실히 수정
- 저장 그룹 삭제 버튼 클릭 시 저장된 그룹 목록을 번호로 보여줌
- 삭제할 번호 선택 후 확인하면 Supabase saved_scoop_groups에서 삭제
- ID를 직접 몰라도 삭제 가능


v34: 랜덤스쿱 버튼 줄에 저장 그룹 삭제 버튼이 실제로 보이도록 강제 삽입했습니다.


v42: v34 안정 베이스에서 다시 만들었습니다. 수동박스 검색은 입력 후 검색 버튼 방식으로만 최소 수정했습니다.

App.jsx 앞부분 확인:
1: 
2: import { useEffect, useMemo, useState } from "react";
3: import { supabase } from "./supabase";
4: 
5: const ADMIN_EMAIL = "qzwxec88888@gmail.com";
6: import * as XLSX from "xlsx";
7: import "./App.css";
8: 
9: const PRICE_RANGES = [
10:   "전체", "0~5000", "5000~10000", "10000~15000", "15000~20000",
11:   "20000~25000", "25000~30000", "30000~35000", "35000+",
12: ];
13: 
14: const TABS = ["대시보드", "재고관리", "수동박스", "랜덤스쿱", "주문관리", "취소보관함", "설정"];
15: 
16: function nowString() {
17:   const d = new Date();
18:   const p = (n) => String(n).padStart(2, "0");
19:   return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
20: }
21: 
22: function toNum(v) {
23:   if (v === null || v === undefined || v === "") return 0;
24:   const cleaned = String(v).replaceAll(",", "").replaceAll("원", "").replaceAll("%", "").trim();
25:   const n = Number(cleaned);
26:   return Number.isFinite(n) ? n : 0;
27: }
28: 
29: function toInt(v) {
30:   return Math.round(toNum(v));
31: }
32: 
33: function money(v) {
34:   return `${toInt(v).toLocaleString()}원`;
35: }
36: 
37: function normalizeColName(value) {
38:   return String(value ?? "")
39:     .trim()
40:     .toLowerCase()
41:     .replace(/[ \t\n\r()[\]{}_\-·./]/g, "");
42: }
43: 
44: function splitMultiValues(value) {
45:   if (!value) return [];
46:   let s = String(value).trim();
47:   ["\n", "\r", "/", "\\", ",", "，", "、", "·", "ㆍ", "|", "&", "+"].forEach((sep) => {
48:     s = s.replaceAll(sep, ",");
49:   });
50:   const out = [];
51:   s.split(",").forEach((v) => {
52:     const t = v.trim().replace(/\s+/g, " ");
53:     if (t && !out.includes(t)) out.push(t);
54:   });
55:   return out;
56: }
57: 
58: function valueMatchesSelected(value, selected) {
59:   if (!selected || selected.length === 0) return true;
60:   const tokens = splitMultiValues(value);
