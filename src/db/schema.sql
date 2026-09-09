-- מערכת כפרות נוף הגליל — סכימת Postgres
-- ראו README.md להסבר על מחזור החיים המלא (הזמנה -> תשלום -> משיכה).

-- ================= הגדרות (key/value, כמו במערכת הספרים) =================
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT INTO settings(key, value) VALUES
  ('order_title', 'הרשמה לכפרות'),
  ('order_subtitle', 'מוסדות חסדי מנחם נוף הגליל'),
  ('admin_password_hash', NULL),  -- סיסמת "בוטסטרפ" ישנה — נבדקת רק כל עוד טבלת admins ריקה, ראו auth.js
  ('deferred_payment_notice',
   'העופות נשמרים בוודאות מוחלטת רק למי ששילם בפועל בשעת ההזמנה.'),
  ('unpaid_block_message',
   'עליך לגשת למשרד להסדרת התשלום טרם מימוש ההזמנה.'),
  ('partial_payment_notice',
   'שולם באופן חלקי — ניתן למשוך רק את ההזמנות ששולמו. יתרת החוב טעונה תשלום במשרד או דרך כפתור התשלום באזור האישי.'),
  ('sms_otp_template', 'קוד האימות שלך: {code} (בתוקף ל-10 דקות)'),
  ('closed_registration_message', 'חלון ההזמנות סגור כרגע, ייפתח בקרוב.'),
  ('welcome_notice_title', ''),   -- כותרת חלונית הסבר במסך הראשי (ריק = לא מוצגת)
  ('welcome_notice_body', '')     -- תוכן חלונית ההסבר
ON CONFLICT (key) DO NOTHING;
-- ניקוי מפתחות מהדגם הישן (יום/שעה קבועים, מנהל יחיד, "זמן פעיל" גלובלי יחיד,
-- ומתגי-העל הגלובליים registration_open/distribution_open) — כולם הוחלפו
-- בשליטה פר-זמן-חלוקה (distribution_slots) ו-admins
DELETE FROM settings WHERE key IN ('active_day', 'active_time_slot', 'admin_phone', 'normalized_admin_phone', 'active_slot_id', 'registration_open', 'distribution_open');

-- ================= זמני חלוקה: מנוהלים לגמרי ע"י המנהל =================
-- מחליף גם את "יום קבוע" (חמישי/ראשון) וגם את טבלת price_rules הישנה —
-- כל שורה היא "אירוע" עצמאי עם התאריך, השעות והמחירים שלו. שינוי מחיר כאן
-- משפיע רק על הזמנות *חדשות* לאותו זמן — הזמנות קיימות שומרות את unit_price
-- שהוקפא ב-order_items בזמן ההזמנה.
CREATE TABLE IF NOT EXISTS distribution_slots (
  id                    SERIAL PRIMARY KEY,
  name                  TEXT NOT NULL,             -- שם חופשי, למשל "חמישי בוקר — ערב יום כיפור"
  supply_date           DATE NOT NULL,              -- תאריך אספקת העופות (לועזי)
  day_label             TEXT NOT NULL,              -- יום בשבוע, טקסט חופשי (מוצע אוטומטית מהתאריך, ניתן לעריכה)
  hours_label           TEXT NOT NULL DEFAULT '',   -- טווח שעות, טקסט חופשי
  color                 TEXT NOT NULL DEFAULT '#a5741f', -- צבע מזהה לזמן הזה (hex) — מוצג במסך "מימוש הכל" בקיוסק
  price_male            NUMERIC(10,2) NOT NULL,
  price_female          NUMERIC(10,2) NOT NULL,
  registration_close_at TIMESTAMPTZ,                -- NULL = אין סגירה אוטומטית להרשמה
  manual_open_override  BOOLEAN NOT NULL DEFAULT FALSE, -- מנהל מסמן "עדיין פתוח *להרשמה*" ידנית, גם אחרי זמן הסגירה
  open_for_pickup       BOOLEAN NOT NULL DEFAULT FALSE, -- מסומן ע"י המנהל ביום האירוע — האם ניתן *למשוך* עבור זמן זה כרגע (ראו redemption.js)
  active                BOOLEAN NOT NULL DEFAULT TRUE,  -- הסתרה רכה (לא מוחקים היסטוריה)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TABLE IF EXISTS price_rules;

-- ================= מנהלים: כל אחד עם טלפון+סיסמה+הרשאות משלו =================
CREATE TABLE IF NOT EXISTS admins (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  phone             TEXT NOT NULL,
  normalized_phone  TEXT NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,
  can_settings      BOOLEAN NOT NULL DEFAULT TRUE,  -- טאב "הגדרות" (כולל ניהול מנהלים)
  can_orders        BOOLEAN NOT NULL DEFAULT TRUE,  -- טאב "הזמנות ותשלומים"
  can_dashboard     BOOLEAN NOT NULL DEFAULT TRUE,  -- טאב "דשבורד"
  can_slots         BOOLEAN NOT NULL DEFAULT TRUE,  -- טאב "זמני חלוקה" (תאריכים ומחירים)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ================= קודי אימות סמס (OTP) — לאזור אישי חוזר ולכניסת מנהל =================
CREATE TABLE IF NOT EXISTS otp_codes (
  id               SERIAL PRIMARY KEY,
  normalized_phone TEXT NOT NULL,
  code             TEXT NOT NULL,
  purpose          TEXT NOT NULL CHECK (purpose IN ('personal_area','admin_login')),
  expires_at       TIMESTAMPTZ NOT NULL,
  consumed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_otp_phone_purpose ON otp_codes(normalized_phone, purpose);

-- ================= הזמנות =================
-- "משפחה" מזוהה לפי טלפון בלבד (לא אימייל). כל הזמנה נוספת של אותו טלפון היא
-- "הזמנה מספר 2", "הזמנה מספר 3" וכו' (order_sequence) — לא "שלב ב'".
CREATE SEQUENCE IF NOT EXISTS order_number_seq START WITH 1001;

CREATE TABLE IF NOT EXISTS orders (
  id               SERIAL PRIMARY KEY,
  order_number     INTEGER NOT NULL UNIQUE,          -- מס' קבלה ידידותי, קבוע וגלובלי
  phone            TEXT NOT NULL,
  normalized_phone TEXT NOT NULL,
  customer_name    TEXT NOT NULL,
  notes            TEXT,                               -- הערות חופשיות מהלקוח (בעיקר ב"הזמנה נוספת", שם לא מבקשים שוב שם)
  order_sequence   INTEGER NOT NULL DEFAULT 1,        -- "הזמנה מספר 1/2/3..." עבור טלפון זה
  access_token     TEXT NOT NULL UNIQUE,               -- מזהה לא-ניחוש, לשימוש עתידי (קבלה/לינק ישיר)
  total_amount     NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_phone_sequence
  ON orders(normalized_phone, order_sequence) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(normalized_phone);
-- orders כבר קיימת מפריסות קודמות (CREATE TABLE IF NOT EXISTS לא מוסיף עמודות לטבלה קיימת) —
-- notes הוא שדה חדש, נוסף כאן במפורש.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT;

-- ================= שורות הזמנה: זמן חלוקה + מגדר + כמות =================
-- כל שורה נמשכת/נשלמת בנפרד — quantity_redeemed מתעדכן בעסקה נעולה (FOR UPDATE)
-- בזמן משיכה בפועל, בלי לגעת בשאר שורות אותה הזמנה.
--
-- הדגם הישן (לפני מעבר לזמני חלוקה דינמיים) היה מבוסס עמודות day/time_slot קבועות,
-- בלי slot_id. המעבר לסכימה עם slot_id בוצע פעם אחת בתחילת הפיתוח, לפני
-- שהמערכת עלתה לאוויר, ע"י DROP TABLE + הקמה מחדש. **קריטי: אסור להחזיר את
-- ה-DROP הזה** — הוא רץ בכל דיפלוי (schema.sql מופעל אוטומטית בכל עלייה של
-- השרת), ומאז שיש הזמנות אמיתיות במערכת הוא ימחק את order_items/redemptions
-- מחדש בכל דיפלוי ויבטל את הפריטים של כל ההזמנות הקיימות. זה בדיוק מה שקרה
-- בפועל בהזמנות #1001/#1002 — נוצרו בדיפלוי אחד, ונמחקו בדיפלוי הבא.
CREATE TABLE IF NOT EXISTS order_items (
  id                SERIAL PRIMARY KEY,
  order_id          INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  slot_id           INTEGER NOT NULL REFERENCES distribution_slots(id),
  gender            TEXT NOT NULL CHECK (gender IN ('male','female')),
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  unit_price        NUMERIC(10,2) NOT NULL,            -- תמונת-מצב ממחיר הזמן בזמן ההזמנה, לא נגזר מחדש
  line_total        NUMERIC(10,2) NOT NULL,
  quantity_redeemed INTEGER NOT NULL DEFAULT 0 CHECK (quantity_redeemed <= quantity)
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_slot ON order_items(slot_id);

-- ================= תשלומים: יומן, לא שדה יחיד — מאפשר תשלום חלקי + ריבוי אמצעים =================
CREATE TABLE IF NOT EXISTS payments (
  id                      SERIAL PRIMARY KEY,
  order_id                INTEGER NOT NULL REFERENCES orders(id),
  amount                  NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  method                  TEXT NOT NULL CHECK (method IN
                            ('nedarim_plus','manual_cash','manual_card','manual_admin')),
  nedarim_transaction_id  TEXT,                         -- מזהה עסקת נדרים פלוס (לא ייחודי לבד: תשלום
                                                          -- אחד יכול להתפצל לכמה הזמנות ב"מפל", ראו payment_sessions)
  recorded_by             TEXT NOT NULL,                -- 'customer' | שם המנהל שרשם ידנית
  note                    TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
-- מונע רישום כפול של אותה עסקת נדרים פלוס על אותה הזמנה (הגנת אידמפוטנטיות משנית —
-- ההגנה הראשית היא payment_sessions.status, ראו allocateNedarimPayment ב-payments.js)
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_order_transaction
  ON payments(order_id, nedarim_transaction_id) WHERE nedarim_transaction_id IS NOT NULL;

-- כפתור "תשלום" באזור האישי יוצר כאן שורה אחת (עם token אקראי כ-Param2 מול
-- נדרים פלוס), לפני קריאת CreateTransaction — כך שכשה-Webhook חוזר אנחנו
-- יודעים בדיוק לאיזה טלפון ולאיזה סכום מבוקש הוא שייך, ומקצים אותו ל"מפל"
-- (waterfall) על ההזמנות הפתוחות של אותו טלפון (הישנה ביותר קודם).
CREATE TABLE IF NOT EXISTS payment_sessions (
  id                SERIAL PRIMARY KEY,
  token             TEXT NOT NULL UNIQUE,             -- נשלח כ-Param2 לנדרים פלוס
  normalized_phone  TEXT NOT NULL,
  requested_amount  NUMERIC(10,2) NOT NULL CHECK (requested_amount > 0),
  -- 'dismissed' = מנהל בדק ידנית והחליט להתעלם מהאזהרה (ראו dismissStalePaymentSession ב-payments.js)
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','dismissed')),
  nedarim_transaction_id TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_phone ON payment_sessions(normalized_phone);
-- מרחיב CHECK ישן (pending/completed בלבד) בהתקנות שכבר קיימות מלפני הוספת 'dismissed'
ALTER TABLE payment_sessions DROP CONSTRAINT IF EXISTS payment_sessions_status_check;
ALTER TABLE payment_sessions ADD CONSTRAINT payment_sessions_status_check CHECK (status IN ('pending','completed','dismissed'));

-- לוג גולמי לכל קריאת webhook נכנסת מנדרים פלוס, מוצלחת או לא — לניפוי
-- תקלות ולזיהוי ניסיונות זיוף (חתימה לא תקינה / חותמת זמן חשודה / IP לא מוכר).
CREATE TABLE IF NOT EXISTS webhook_events (
  id             SERIAL PRIMARY KEY,
  provider       TEXT NOT NULL DEFAULT 'nedarim_plus',
  order_id       INTEGER REFERENCES orders(id),
  transaction_id TEXT,
  raw_payload    JSONB NOT NULL,
  processed_ok   BOOLEAN NOT NULL DEFAULT FALSE,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- תצוגת יתרה חיה — לעולם לא שדה מאוחסן, כדי שלא "יתיישן".
CREATE OR REPLACE VIEW order_balances AS
SELECT o.id AS order_id,
       o.total_amount,
       COALESCE(SUM(p.amount), 0) AS amount_paid,
       o.total_amount - COALESCE(SUM(p.amount), 0) AS balance_due,
       CASE
         WHEN COALESCE(SUM(p.amount), 0) <= 0 THEN 'unpaid'
         WHEN COALESCE(SUM(p.amount), 0) >= o.total_amount THEN 'paid'
         ELSE 'partial'
       END AS payment_status
FROM orders o
LEFT JOIN payments p ON p.order_id = o.id
GROUP BY o.id;

-- ================= משיכה בפועל (יום האירוע) =================
CREATE TABLE IF NOT EXISTS redemptions (
  id                 SERIAL PRIMARY KEY,
  order_item_id      INTEGER NOT NULL REFERENCES order_items(id),
  quantity           INTEGER NOT NULL CHECK (quantity > 0),
  confirmation_code  TEXT NOT NULL,     -- מוצג ללקוח, "נשרף" עם המסירה בפועל
  redeemed_by        TEXT NOT NULL,     -- טלפון מאומת (normalized_phone) שביצע את המשיכה
  redeemed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_redemptions_item ON redemptions(order_item_id);

-- ================= יומן פעולות מנהל =================
CREATE TABLE IF NOT EXISTS admin_actions (
  id          SERIAL PRIMARY KEY,
  action_type TEXT NOT NULL,           -- 'manual_payment' | 'hard_reset' | 'edit_price' | 'edit_settings' ...
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- טבלת session ל-express-session תיווצר אוטומטית ע"י connect-pg-simple (createTableIfMissing: true)
