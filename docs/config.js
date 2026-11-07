// ヨミドーパの設定。決済リンクや運営者情報は、ここを書きかえるだけで反映される。
// 空欄("")のものは、画面では「準備中」と表示される。
export const CONFIG = {
  // 運営者の表示名(屋号やペンネームで可)と、問い合わせ用メールアドレス
  operatorName: "ヨミドーパ運営室",
  contactEmail: "",

  // Stripe Payment Links(Stripe のダッシュボードで作ったリンクの URL を貼る)
  support: {
    once: [
      { label: "300円", url: "" },
      { label: "500円", url: "" },
      { label: "1,000円", url: "" },
    ],
    monthly: { label: "毎月300円", url: "" },
  },
  ads: {
    // 本の宣伝(PR投稿)と、一般の広告。価格と期間は運営者が決める
    book: { label: "本の宣伝(PR投稿)", price: "1週間 1,000円(税込)。ただし、開始から先着30件は無料", period: "1週間単位", url: "" },
    general: { label: "一般の広告", price: "1週間 1,000円(税込)。ただし、開始から先着30件は無料", period: "1週間単位", url: "" },
  },

  // Supabase(いいね・フォロー・広告申し込みに使う)。URL と公開用キー(anon / publishable)だけを書く。
  // service_role などの秘密のキーは、絶対にここに書かない。
  supabase: { url: "", anonKey: "" },
};
