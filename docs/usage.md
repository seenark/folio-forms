# Folio Forms — คู่มือใช้งานและ Deploy

Folio Forms เป็นระบบสร้างและกรอกแบบฟอร์ม DOCX โดยใช้ ONLYOFFICE เป็น Document Editor

- **Admin** สร้าง Template, กำหนด Field, Publish และดู Submission
- **User** เปิดลิงก์แบบฟอร์ม, กรอกข้อมูล, Save Draft, Resume และ Submit
- **API** รันด้วย Bun + Elysia ที่ port `3000`
- **Web** รันด้วย React + Vite ที่ port `5173`
- **ONLYOFFICE Docs** รันใน Docker ที่ port `8080`
- **PostgreSQL** รันใน Docker ที่ port `5432`
- **RustFS** เก็บ DOCX ใน private S3 bucket ที่ port `9000` และมี console local ที่ port `9001`

เอกสารนี้อธิบายการรันระบบ MMVP, การใช้ Share Link, การจัดการ Form และตำแหน่งข้อมูลสำคัญ

## Production single-host Compose

Production uses the canonical `compose.yaml` with Caddy as the only public entry point. The Forms host serves the React app and API; the Office host serves ONLYOFFICE. PostgreSQL, RustFS, and the application containers stay on the private Compose network with no published host ports.

Create an uncommitted deployment environment file with independent values for `DATABASE_URL`, `BETTER_AUTH_SECRET`, `EDITOR_CAPABILITY_SECRET`, `PREFILL_HANDOFF_SECRET`, `ONLYOFFICE_JWT_SECRET`, `RUSTFS_ACCESS_KEY_ID`, `RUSTFS_SECRET_ACCESS_KEY`, `RUSTFS_BUCKET`, `FORMS_HOST`, `OFFICE_HOST`, `CADDY_EMAIL`, and `PREFILL_RETURN_URL`. Set `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` consistently with `DATABASE_URL`. Bootstrap variables are needed only on the first empty database and may be removed after the first Admin replaces the temporary password.

Start the stack:

```bash
docker compose --env-file .env.production -f compose.yaml up -d --build
docker compose --env-file .env.production -f compose.yaml ps
curl -f https://forms.example.test/ready
```

The server applies checked-in Prisma migrations before listening, creates only the configured first Admin, and runs recovery reconciliation before serving readiness. Restart recovery expires stale Handoffs, Editor Leases, Operations, and callback claims, then retries only durable cleanup intents. Volumes preserve PostgreSQL, RustFS, ONLYOFFICE, and Caddy state.

The stack has no application or off-host backup. Loss of the attached disk, ransomware, or regional failure is unrecoverable. The supported operating ceiling remains roughly 100 accounts, 100 Forms, and 20 concurrent editors; no queue, distributed lock, or horizontal scaling layer is included.

The deterministic external connector is never enabled by default. For explicit verification only:

```bash
docker compose --env-file .env.production -f compose.yaml --profile verification up prefill-mock
```


## 1. Development Mode

สำหรับการพัฒนาเร็ว ให้รัน API และ Web ด้วย Bun โดยชี้ `apps/server/.env` ไปยัง PostgreSQL, RustFS และ ONLYOFFICE ที่เตรียมไว้สำหรับ development. ใช้ `apps/server/.env.example` เป็นรูปแบบ และใช้ credential local เฉพาะเครื่องเท่านั้น.

```bash
cp apps/server/.env.example apps/server/.env
bun run --cwd packages/db db:generate
bun run --cwd apps/server db:migrate
bun run dev
```

Host API (`3000`) กับ Compose `server` ห้ามเปิดพร้อมกัน. Production ให้ใช้ขั้นตอนในหัวข้อ **Production single-host Compose** แทน; production Compose ไม่ publish port ของ PostgreSQL, RustFS, ONLYOFFICE หรือ Server.

## 2. Accounts

### 2.1 Application accounts

การติดตั้งใหม่สร้าง Admin คนแรกจากค่า bootstrap เมื่อยังไม่มี Admin เท่านั้น หลังจากนั้น Admin สร้างและจัดการบัญชีทั้งหมด ระบบไม่มี public sign-up, บัญชี demo หรือรหัสผ่านคงที่ เปิด `/admin/users` เพื่อค้นหาด้วยอีเมลที่ normalize แล้ว กรองตาม Role/สถานะ และเปิดหน้าถัดไปแบบ cursor Admin ทุกคนมีสิทธิ์จัดการบัญชีเท่ากัน แต่ระบบจะปฏิเสธคำขอที่ทำให้ไม่เหลือ Admin ที่เปิดใช้งาน

เมื่อสร้างบัญชีหรือ Reset password เซิร์ฟเวอร์จะสุ่มรหัสผ่านชั่วคราวอย่างน้อย 20 ตัวอักษรและแสดงในผลลัพธ์ครั้งเดียวเท่านั้น ผู้รับต้องเปลี่ยนรหัสผ่านก่อนใช้ส่วนอื่นของระบบ การ Disable, เปลี่ยนอีเมล, เปลี่ยน Role หรือ Reset password จะ revoke Session ทั้งหมดของบัญชีนั้นทันที

ทุกความพยายามจัดการบัญชีจะเพิ่ม Audit Event แบบ immutable พร้อมผู้กระทำ เป้าหมาย เวลา Action และ Outcome โดยไม่เก็บรหัสผ่าน, password hash, token หรือ credential material

การ **ลบบัญชีถาวร** ทำได้เมื่อบัญชีนั้นไม่มี `Response` หรือไฟล์ส่วนบุคคลค้างอยู่แล้วเท่านั้น ต้องลบ Response จากหน้า **ผลลัพธ์** ก่อน ระบบจะ revoke Session และล้างข้อมูลที่เกี่ยวข้องก่อนลบบัญชี ส่วนการ Disable ยังคง Response, Prefill และ Audit ไว้เพื่อการตรวจสอบภายหลัง
หน้า **Audit Trail** ที่ `/admin/audit` เป็น read-only สำหรับ Admin เท่านั้น รองรับกรองตามช่วงเวลา, Actor ID, Action, Target ID และ Outcome พร้อม cursor pagination ลำดับเวลา/ID คงที่ Metadata ที่แสดงเป็น allowlist และไม่รวมค่า Field, Prefill, เอกสาร, token หรือ request body

### 2.2 สิทธิ์ของแต่ละ Role

#### Admin

- เข้า `/admin`
- จัดการบัญชีที่ `/admin/users`
- สร้าง Form ใหม่จาก Starter DOCX หรืออัปโหลดไฟล์ `.docx`
- ดูสถานะ Form พร้อมจำนวน Draft และ Submission
- ลบ Form ที่ยังไม่เคย Publish และยังไม่มี Response
- แก้ไข DOCX Template ภายใต้ Editor Lease แบบ exclusive
- Save Template Draft อย่างชัดเจน
- Publish Template
- Copy Share Link
- ดู Submission ของทุก User
- Download Submission เป็น DOCX หรือ PDF

#### User

- เปิด Share Link
- กรอก Form
- Save Draft
- Resume Draft จาก Dashboard
- Submit Form
- ดู Receipt และไฟล์ของตัวเอง

### 2.3 บัญชีเก็บที่ไหน

บัญชีและ session เก็บใน PostgreSQL ผ่าน Better Auth และ Prisma

การตั้งค่า Authentication อยู่ที่:

```text
packages/auth/src/index.ts
```

ข้อมูล Runtime อยู่ใน PostgreSQL ตารางหลักเหล่านี้:

```text
user          email, name และ role
account       Better Auth credential และ password hash
session       session token และวันหมดอายุ
verification  ข้อมูล verification
audit_events  ผู้กระทำ เป้าหมาย Action, Outcome และ metadata ที่ไม่มี secret
```

Password จริงในฐานข้อมูลถูกจัดการโดย Better Auth ไม่ได้เก็บเป็น Plain Text

Browser เก็บ Bearer session token ที่:

```text
localStorage["onlyoffice.sessionToken"]
```

ไม่ควรเปิดดูหรือแชร์ Token นี้

Bearer session นี้ใช้เฉพาะระหว่าง Web กับ API และจะไม่ถูกส่งเข้า ONLYOFFICE หรือ Plugin เมื่อเปิด Editor ระบบจะ claim Editor Lease อายุ 90 วินาทีให้กับ Browser Session หนึ่งรายการต่อ Template Draft หรือ Response และ Browser จะต่ออายุทุก 30 วินาที Session อื่นจะเปิดแก้ไขไม่ได้จนกว่า Lease ถูกปล่อยหรือหมดอายุ ก่อนทำแต่ละ Editor action หน้า Web จะใช้ Session ขอ capability อายุ 5 นาทีใหม่ แล้วส่งเฉพาะ capability ที่ผูกกับผู้ใช้, role, Form, document, action และ Lease ที่ยัง active ผ่าน bridge ที่ตรวจ origin และ window source ส่วน Document Server ใช้ `ONLYOFFICE_JWT_SECRET` แยกต่างหากสำหรับเปิดไฟล์ private, callback, command และ conversion

## 3. ทดลองใช้งานในฐานะ User

1. เปิด Share Link ที่ Admin คัดลอกจาก Form ที่ Publish แล้ว
2. Login ด้วยบัญชี User ที่ provision ไว้
3. ตรวจค่า Prefill และ Field ที่ถูก lock
4. กด **Save Draft** เพื่อบันทึกและกลับมาทำต่อ
5. กด **Submit** เพื่อสร้าง Submission แบบ immutable
6. เปิด Receipt จาก Dashboard
7. ดาวน์โหลด DOCX หรือขอ PDF export เมื่อจำเป็น

Share Link เป็น opaque public ID ที่ระบบสร้างให้แต่ละ Form ไม่มีค่า demo แบบคงที่

### 3.1 วงจร Draft และ Receipt

`Response` มีได้หนึ่งรายการต่อ User และ Form เดียวกันเท่านั้น การกด **Save Draft** จะเก็บค่า Field และ DOCX ล่าสุดที่ตรวจสอบแล้ว ส่วน Field ที่ยังไม่ครบ Required ยังบันทึกเป็น Draft ได้ เมื่อกด **Submit** ระบบจะ Force-save เอกสาร ตรวจ Field Manifest แล้วสร้าง `Submission` และ DOCX ต้นฉบับแบบ immutable ใน transaction เดียวกัน หาก Force-save, Callback หรือการตรวจเอกสารล้มเหลว ระบบจะคง Draft เดิมไว้และสามารถลอง Submit ใหม่ได้

หลัง Submit สำเร็จ การเปิด Form หรือ Handoff ซ้ำจะพาไป Receipt เดิม ไม่สร้าง Response ใหม่ Receipt แสดงชื่อ Form สถานะเวลาส่ง และข้อมูลต้นฉบับแบบอ่านอย่างเดียว เจ้าของ Response และ Admin ดาวน์โหลด JSON/DOCX ต้นฉบับได้ ส่วน PDF สร้างจาก DOCX เมื่อร้องขอและไม่เก็บเป็นไฟล์ถาวรใน PostgreSQL หรือ RustFS

### 3.2 เก็บถาวรและเปิดรับคำตอบอีกครั้ง

Admin เก็บถาวรได้เฉพาะ Form ที่ Publish แล้วจากหน้ารายละเอียดหรือรายการ Form การเก็บถาวรคง Public ID, Published Template, Field Manifest และ Prefill เดิมไว้ แต่ไม่รับ Response ใหม่ ผู้ใช้ที่ยังมี Draft หรือ Submission เดิมจะเปิดต่อ, Save, Submit และดาวน์โหลด Receipt/ไฟล์เดิมได้

เมื่อยกเลิกเก็บถาวร Form จะกลับมารับคำตอบใหม่ด้วยสัญญาเอกสารเดิม การเปลี่ยนสถานะเพิ่ม Audit Event ที่ระบุผู้กระทำ Form เวลา และผลลัพธ์ หากเปิด Share Link ของ Form ที่เก็บถาวรโดยยังไม่มี Response ระบบจะแสดงว่า Form ไม่พร้อมใช้งานหลัง Login และไม่เปิดเผย metadata ก่อน Login

### 3.3 บันทึก ส่งออก และทิ้งฉบับร่าง

ในหน้า Fill ระบบแสดงสถานะการเปลี่ยนแปลงของเอกสารอย่างชัดเจน การกด **บันทึกและดาวน์โหลด DOCX/PDF** จะสั่ง Save Draft ให้เสร็จก่อน แล้วจึงดาวน์โหลดไฟล์ฉบับร่างล่าสุด หาก Save Draft ล้มเหลว ระบบจะไม่เริ่มดาวน์โหลดและยังคงข้อมูล Draft เดิม

การออกจากหน้า, Reload, ปิดแท็บ หรือ Session ใกล้หมดอายุขณะมีการแก้ไขที่ยังไม่บันทึกจะแสดงคำเตือน ผู้ใช้เลือก **บันทึกแล้วออก**, **ทิ้งฉบับร่าง** หรืออยู่ต่อได้ การกด **ทิ้งฉบับร่าง** เป็นการลบข้อมูล Draft, Response Document, Lease และไฟล์ที่รอ cleanup อย่างถาวร และทำซ้ำได้อย่างปลอดภัย ปุ่มทิ้งฉบับร่างใน Dashboard ใช้การยืนยันอีกครั้ง

ระบบเตือนก่อน Session หมดอายุ 5 นาที ผู้ใช้สามารถบันทึกก่อนเข้าสู่ระบบใหม่ได้ หลัง Re-authentication ระบบกลับมาที่ Response เดิมด้วย `responseId` แบบ opaque เท่านั้น ไม่ส่งค่าฟิลด์, Prefill, claims หรือ token ผ่าน URL หรือ localStorage

Admin เปิด Receipt หรือหน้า Results เพื่อสลับดูข้อมูล Submission เดิมกับ Correction ล่าสุดและดาวน์โหลด Revision ที่เลือกได้ การลบ Response ถาวรจากหน้า Results ต้องยืนยันอีกครั้ง ระบบจะล้าง Draft, Submission, Prefill, Correction, Session และไฟล์ RustFS ที่เกี่ยวข้อง ไม่เก็บค่าฟิลด์หรือเหตุผลไว้ใน Audit และ retry ได้เมื่อการล้างไฟล์ภายนอกยังไม่เสร็จ

### 3.4 External editable Prefill Handoff

ระบบตัวอย่างภายนอกใช้ Schema pointer จาก External Mock แล้วเรียก `POST /api/integrations/prefill/handoffs` ด้วย Header `X-Prefill-Handoff-Secret` ซึ่งต้องมาจาก deployment secret ชื่อ `PREFILL_HANDOFF_SECRET` และต้องแยกจาก secret ของ Editor capability, Auth และ ONLYOFFICE JWT พร้อมข้อมูล `publicId`, email, External Reference และค่า scalar candidate ระบบจะ normalize email และเลือกเก็บเฉพาะค่าที่ตรงกับ Prefill Configuration ที่ Publish แล้วเท่านั้น Runnable External Mock อยู่ที่ `apps/prefill-mock` ใช้ `FOLIO_ORIGIN` และ `PREFILL_HANDOFF_SECRET` แล้วรัน `bun run --cwd apps/prefill-mock start` โดย `/schema` ให้ catalog แบบ deterministic, `/handoffs` เป็น connector ฝั่ง server-to-server และ `/launch` สร้าง HTML form ที่ส่ง code ตรงไปยัง Folio เพื่อให้ Cookie อยู่บน Folio host

ผลลัพธ์มี one-time code จาก random 32 bytes และ `launchPath` เท่านั้น ระบบต้นทางต้องส่ง code ใน body ของฟอร์ม `POST` แบบ top-level ไปยัง `/prefill/handoff` ห้ามใส่ code ใน URL ระบบเก็บเฉพาะ digest ของ code และหมดอายุใน 120 วินาที เมื่อ Launch สำเร็จ Folio จะแลก code เป็น Cookie `__Host-folio-pending-claim` อายุ 10 นาที โดยมี `Secure`, `HttpOnly`, `SameSite=Lax` และ `Path=/` Cookie นี้เป็น claim แบบชั่วคราว ไม่เปิดให้ JavaScript อ่าน และไม่มี code หรือค่า Prefill ใน URL, `localStorage` หรือ `sessionStorage`

หลัง Login และ Password replacement เสร็จ หน้า Form เดิมจะส่ง claim ไป redeem เพียงครั้งเดียว ระบบตรวจ email, Form, configuration hash และอายุใน transaction แบบ serializable ก่อนสร้าง Response เดียว, คัดลอก Published DOCX และ snapshot ค่า Prefill ตาม policy (`editable` หรือ `lock-when-available`) Form ที่มี Prefill fields จะไม่รับการเริ่มแบบ share link ปกติ ส่วน Form ที่ไม่มี Prefill fields ยังเริ่มแบบปกติได้ การทิ้ง Draft จะล้าง Prefill และทำให้ต้องขอ Handoff ใหม่

Code ที่ผิด, หมดอายุ, ใช้ซ้ำ หรือผูกกับ email/Form/configuration ไม่ตรงกันจะปิดกั้นการ redeem และแสดงสถานะภาษาไทยที่มีปุ่มลองใหม่/กลับไปยังระบบต้นทาง Audit Event ของ Handoff เก็บเฉพาะ target reference ที่ปลอดภัย ไม่เก็บค่า Prefill, code, secret, document หรือ identity ระบบต้นทาง poll สถานะได้ผ่าน External Mock ที่ `POST /status` โดยส่งเฉพาะ External Reference และ shared secret เดิม ผลลัพธ์เปิดเผยเฉพาะ `pending`, `draft`, `submitted`, `deleted` หรือ `expired` พร้อม timestamp ของ lifecycle และเลข Correction ล่าสุดถ้ามี ไม่คืน identity, ค่า Field, Prefill, object URL, Session หรือ internal ID ระบบไม่มี webhook/email/SMS/callback ขาเข้า Handoff ที่ยังไม่ redeem จะถูก sweep ทุก 60 วินาทีหลังหมดอายุ โดยคงไว้เฉพาะ lookup digest และ timestamp ที่จำเป็น

Receipt มีปุ่ม **กลับไปยังระบบต้นทาง** เพียงปุ่มเดียวสำหรับ keyboard โดยใช้ URL จาก `PREFILL_RETURN_URL` ที่กำหนดตอน deploy เท่านั้น ค่า Handoff ไม่สามารถเปลี่ยน URL นี้หรือสร้าง open redirect ได้

## 4. ทดลองใช้งานในฐานะ Admin

1. เปิด `http://localhost:5173/login`
2. Login ด้วยบัญชีที่ถูก provision เป็น role `Admin`
3. ระบบจะพาไปที่ `/admin`

หากต้องจัดการบัญชี ให้เปิดเมนู **ผู้ใช้** หรือ `/admin/users` หน้าเดียวกันรองรับการสร้างบัญชี แก้ไขอีเมล เปิด/ปิดบัญชี Promote/Demote และ Reset password คัดลอกรหัสผ่านชั่วคราวจากผลลัพธ์ก่อนเปลี่ยนหน้า เพราะ API จะไม่ส่งค่านั้นซ้ำ

4. กด **สร้างแบบฟอร์ม**
5. กรอกชื่อและคำอธิบาย
6. เลือก Starter DOCX ของระบบ หรืออัปโหลดไฟล์ `.docx` ขนาดไม่เกิน 25 MiB
7. กด **สร้าง Template Draft**
8. ระบบจะตรวจชนิด ขนาด และโครงสร้าง DOCX ก่อนสร้าง Form แล้วเปิด ONLYOFFICE Editor

หน้า `/admin` แสดงสถานะ `Draft`, `Published` หรือ `Archived` พร้อมจำนวน Response Draft และ Submission โดยใช้ Public ID สำหรับเส้นทางและไม่แสดง Object Key หรือ Database ID

ถ้าเลือกอัปโหลด ไฟล์ต้องลงท้ายด้วย `.docx` และเป็นแพ็กเกจ DOCX ที่อ่านได้จริง ไฟล์ชนิดอื่น ไฟล์ใหญ่กว่า 25 MiB หรือ ZIP ที่ขาดส่วนประกอบ DOCX จะถูกปฏิเสธก่อนสร้าง Form

### 4.1 ออกแบบ Template

ใน DOCX ต้องใช้ ONLYOFFICE Content Controls และตั้ง Tag ให้ทุก Field

กฎสำคัญ:

- ทุก Content Control ต้องมี Tag
- Tag ต้องไม่ซ้ำกันใน Form เดียวกัน
- Tag เป็นชื่อที่ใช้ใน JSON และ Prefill
- Tag ควรเป็นชื่อที่สื่อความหมาย เช่น `/person/name` (RFC 6901 JSON Pointer)

Editor หนึ่งรายการมี Admin แก้ไขได้ครั้งละหนึ่ง Browser Session เท่านั้น Admin คนที่สองจะเห็นสถานะไม่สามารถแก้ไขได้และสามารถลองใหม่หลัง Lease ถูกปล่อยหรือหมดอายุ

#### ตั้งค่า Field ในแผงด้านข้าง

ขณะเปิด Template Draft ใน ONLYOFFICE ให้เลือก Content Control แล้วใช้แผง **Form Bridge** ด้านขวา แผงนี้จะแสดง Tag ของ Field ที่เลือก, ตัวเลือก Required และนโยบาย Prefill:

- `editable` — ผู้ใช้แก้ค่าได้เมื่อมีค่า Prefill
- `lock-when-available` — ล็อกเฉพาะเมื่อ Handoff ที่เชื่อถือได้มีค่าสำหรับ Field นี้

การค้นหา Schema ใช้ External Mock เดียวของระบบและแบ่งผลลัพธ์ด้วย Cursor ผลลัพธ์มีเฉพาะ Leaf ที่เป็น scalar พร้อม RFC 6901 JSON Pointer เช่น `/person/name` และไม่แสดง Object, Array, User record หรือค่าจริงของ record กด **คัดลอกคีย์** เพื่อคัดลอก Pointer ที่ตรงตัว หรือกด **ใช้เป็น Tag** เพื่อใส่ Pointer นั้นใน Content Control ที่เลือก จากนั้นกด **บันทึกการตั้งค่า Field** การเปลี่ยน Tag จะล้างนโยบายของ Tag เดิมแบบ atomic เพื่อไม่ให้เหลือกฎขัดแย้ง

รองรับ Content Control แบบ scalar สำหรับ Text, Checkbox, Date, Dropdown และ Combo box รวมถึง Picture แบบ native ของ ONLYOFFICE การ Save Template จะเก็บเอกสารล่าสุดและกฎ Field เพื่อเปิดกลับมาได้เหมือนเดิม แต่ Publish จะตรวจชนิด ตัวเลือก Tag และนโยบายอีกครั้ง แล้วบันทึก Field Manifest ที่เป็น authoritative contract

Picture ใช้ภาพที่เลือกผ่าน Content Control ของ ONLYOFFICE เท่านั้น: ต้องฝังภาพ JPEG หรือ PNG ได้ไม่เกิน 1 ภาพต่อ Field ขนาดไฟล์ไม่เกิน 10 MiB และกว้าง/สูงไม่เกิน 4096×4096 พิกเซล หากตั้ง Required ต้องมีภาพอยู่ใน Field เอกสาร DOCX ที่ฝังภาพเป็นแหล่งข้อมูลหลัก ไม่มี remote Prefill, การอัปโหลดรูปภาพแยก หรือ image object แยกต่างหาก แผงจะแสดงข้อจำกัดและปิดการตั้งค่า Prefill สำหรับ Picture ส่วนรูปภาพคงที่นอก Field ยังคงแก้ไขไม่ได้

เมื่อแก้ไข Template เสร็จ:

1. เปิดแท็บ **Form** ใน ONLYOFFICE
2. กด **บันทึก Template** อย่างชัดเจน
3. รอให้ Operation เสร็จ ระบบจะเปิดครั้งถัดไปจาก DOCX ชุดเดียวกับการบันทึกล่าสุด
4. ถ้าการบันทึกล้มเหลว Template Draft ชุดก่อนหน้ายังอยู่และกด **ลองใหม่** ได้
5. ตรวจให้แน่ใจว่า Tag ไม่ว่าง ไม่ซ้ำ และใช้เฉพาะ Content Control แบบ scalar ที่รองรับ
6. กด **Publish** เมื่อ Template พร้อม
7. กด **คัดลอกลิงก์** เพื่อส่งให้ User

การ Publish สำเร็จจะสร้าง Published Template, Field Manifest และ Prefill Configuration เพียงชุดเดียวต่อ Form พร้อม Public ID แบบ opaque ที่ระบบสร้างให้เอง เอกสารและสัญญา Field/Prefill จะ immutable: Save และ Publish ไม่สามารถแทนที่หรือแก้โครงสร้างเดิมใน Form เดิมได้ หากต้องเปลี่ยนโครงสร้างหรือ policy ให้สร้าง Form ใหม่และใช้ Share Link ใหม่ หลัง Publish Admin ยังแก้เฉพาะชื่อและคำอธิบายได้ โดย Public ID, Published DOCX, Field Manifest และ Prefill Configuration เดิมจะไม่เปลี่ยน หากต้องแก้โครงสร้างหรือ Required/Prefill policy ให้กด **Duplicate Form** เพื่อสร้าง Draft ใหม่พร้อม DOCX และกฎที่เป็นอิสระ ใช้ Public ID ใหม่ และไม่คัดลอก Response, Submission, Operation, Lease หรือประวัติ Audit จากต้นฉบับ แบบฟอร์มที่ Publish แล้วลบถาวรหรือเปลี่ยนกลับเป็น Draft ไม่ได้

Form ที่ยังเป็น `Draft`, ไม่เคย Publish และไม่มี Response เท่านั้นที่ลบแบบถาวรได้ การลบจะล้าง Template Draft และ Object ที่เกี่ยวข้อง แต่ Form สถานะอื่นใช้เส้นทางนี้ไม่ได้

หน้า Admin ยังมีปุ่มด้านบนด้วย:

- **บันทึก Template** — สร้าง Operation และบันทึก Template Draft ก่อน Publish
- **Publish** — ตรวจ DOCX และสร้าง Published Template แบบ immutable ครั้งเดียว

### 4.2 ผลของการ Publish

การ Publish Template จะ:

- เปลี่ยนสถานะ Form เป็น `Published` และใช้ Manifest เดียวกันสำหรับ Response ใหม่
- ปกป้อง share link ด้วย Public ID แบบ opaque ไม่ใช้ Database ID หรือ slug ที่ผู้ใช้กำหนด
- ไม่เปิดเผย metadata ของ Form ให้ผู้ที่ยังไม่ Login; ผู้ใช้ที่ Login แล้วจึงได้รับ metadata ที่อนุญาต
- บันทึก Audit Event แบบไม่เก็บ secret
- ถ้าล้มเหลวจะไม่สร้าง Published Template หรือ share link และ Template Draft เดิมยังแก้ไขต่อได้

การเปลี่ยนโครงสร้าง, Tag, required state หรือ Prefill policy ใน Form ที่ Publish แล้วทำไม่ได้ในที่เดิม ให้สร้าง Form ใหม่

### 4.3 กรอกและ Resume ในฐานะ User

1. Login ก่อนเปิด Share Link; บัญชีที่ถูกปิดใช้งานจะเริ่มคำตอบไม่ได้
2. ระบบสร้าง Response ได้อย่างน้อยหนึ่งรายการต่อ User ต่อ Form แม้มีการกดเริ่มพร้อมกัน
3. เปิดแท็บ **Form** แล้วแก้ได้เฉพาะ Content Control ที่มี Tag; ข้อความคงที่และรูปภาพคงที่นอก Field แก้ไม่ได้ ส่วน Picture ต้องเลือกผ่าน native control ของ ONLYOFFICE
4. กด **Save Draft** อย่างชัดเจนเพื่อบันทึกค่าที่กรอก ค่า scalar และ Picture ที่ไม่ครบยังบันทึกได้ แต่ก่อน Submit Picture ที่ตั้ง Required ต้องมีภาพและต้องผ่านชนิด จำนวน ขนาดไบต์ และขนาดพิกเซล
5. ค่า scalar ต้องตรงกับ Field Manifest: text/combo ไม่เกิน 10,000 ตัวอักษร, JSON รวมไม่เกิน 256 KiB, ส่วน dropdown/date/checkbox ต้องเป็น option, วันที่ หรือ boolean ที่ถูกต้อง
6. กลับหน้า Dashboard เพื่อดูชื่อ Form และเวลาบันทึกล่าสุด แล้วกด **กลับไปกรอกต่อ** เพื่อเปิด Response เดิม
7. เฉพาะ User เจ้าของเท่านั้นที่อ่าน Response, Operation, editor configuration และ DOCX ได้

### 4.4 ดู Submission

จากหน้า Form editor กด:

```text
View submissions
```

Admin จะสามารถดูข้อมูล, เปิด Receipt และดาวน์โหลด DOCX/PDF ได้

หน้า Results มีปุ่ม **ลบคำตอบถาวร** สำหรับ Admin เท่านั้น การลบจะคง Tombstone และสถานะ External Handoff เป็น `deleted` โดยเปิดเผยเพียง timestamp ที่จำเป็น หาก RustFS ตอบผิดพลาด ระบบจะเก็บ cleanup intent ไว้และให้ retry จากคำขอเดิมได้โดยไม่ทำให้ข้อมูลที่ลบแล้วกลับมา

## 5. URL สำคัญ

| URL | ใช้งาน |
| --- | --- |
| `http://localhost:5173` | หน้าเริ่มต้น |
| `http://localhost:5173/login` | Login |
| `http://localhost:5173/dashboard` | Dashboard ของ User |
| `http://localhost:5173/admin` | Dashboard ของ Admin |
| `http://localhost:5173/admin/users` | จัดการบัญชี User และ Admin |
| `http://localhost:5173/admin/forms/new` | สร้าง Form |
| `http://localhost:3000/health` | ตรวจ API |
| `http://localhost:8080` | ONLYOFFICE Document Server |
| `http://localhost:9001` | RustFS console สำหรับ local development |

ถ้าเปิด Share Link โดยยังไม่ Login ระบบจะพาไป `/login` ก่อน แล้วกลับมายัง Form เดิมหลัง Login สำเร็จ

## 6. ไฟล์สำคัญใน Repository

```text
apps/
  server/
    src/app.ts         API routes และ workflow หลัก
    src/index.ts       Production listen entrypoint
    src/storage.ts     Private RustFS object primitives
    src/onlyoffice.ts  Editor capability, ONLYOFFICE JWT, document access, force-save และ PDF conversion
    .env               Environment local จริง
    src/routes/        หน้า Login, Dashboard, Admin, Fill และ Receipt
    src/components/
      onlyoffice-editor.tsx  ฝัง ONLYOFFICE ในหน้าเว็บ
    src/lib/
      api.ts            API client และ session token

  onlyoffice-plugin/
    index.html          Plugin entrypoint and Admin right-side Field panel
    plugin.js           Form panel, schema search, Field policy, Prefill, Extract, Save Draft และ Submit

packages/
  auth/
    src/index.ts        Better Auth configuration
  db/
    prisma/schema.prisma  Prisma schema
    prisma/migrations/   SQL migrations ที่ checked in
  env/
    src/server.ts       ตรวจสอบ Environment variables

onlyoffice-templates/
  template.docx         Template DOCX ต้นฉบับ

compose.yaml            PostgreSQL, RustFS, ONLYOFFICE และ API services
```

## 7. ที่เก็บข้อมูลและ Artifact

### 7.1 PostgreSQL

ตาราง Application หลัก:

```text
Form / TemplateDraft / PublishedTemplate / FieldManifest
PrefillConfiguration / PrefillSnapshot
Response / Submission / Correction
Handoff / PendingClaim
Operation / CallbackClaim / EditorLease / ObjectCleanupIntent
AuditEvent / LoginFailure / DeletionTombstone
```

### 7.2 Private DOCX objects

RustFS เก็บ Template Draft, Published Template, Response Draft, Submission และไฟล์ staging ของ Operation ใน bucket `RUSTFS_BUCKET` ตัวอย่าง object key:

```text
forms/<formId>/template-draft/<uuid>/docx
forms/<formId>/published/<version>/<uuid>/docx
responses/<responseId>/draft/<uuid>/docx
submissions/<submissionId>/filled/<uuid>/docx
operations/<operationId>/<kind>/<uuid>/docx
```

Database เก็บ object key ไม่ใช่ Absolute path ของเครื่อง Bucket ไม่มี public access Browser และ ONLYOFFICE ต้องอ่านผ่าน API ที่ตรวจสิทธิ์และใช้ authorization อายุสั้นเท่านั้น ระบบเขียน staging object ให้สำเร็จก่อนเปลี่ยน reference ใน Database แล้วจึงลบ object เก่าหรือ staging ที่หมดหน้าที่ การสร้างและลบ Form จะบันทึก `ObjectCleanupIntent` ก่อนที่ object อาจไม่มี reference โดย intent ของการสร้างใหม่มีช่วงคุ้มครอง 15 นาทีเพื่อไม่ให้ Server อื่นลบ object ที่ยังอัปโหลดอยู่ ถ้าลบจาก RustFS ไม่สำเร็จ intent จะยังอยู่และ Server จะลองใหม่ตอนเริ่มระบบและทุกหนึ่งนาที Callback claim ถูกเก็บและ consume แบบครั้งเดียวใน Database เพื่อให้ replay protection ยังทำงานหลัง restart และตอนเริ่ม Server ระบบจะ fail Operation ที่ค้างเกินเวลา, rollback Response ที่กำลัง submit และล้าง Lease หรือ callback claim ที่หมดอายุโดยไม่เปลี่ยน reference ของเอกสารที่ commit แล้ว

PDF ถูกสร้างเมื่อดาวน์โหลด ส่งกลับใน response แล้วทิ้งทันที ไม่มี PDF object ถาวรหรือ path ใน Database

### 7.3 Docker volumes

```text
postgres-data-v18   ข้อมูล PostgreSQL
onlyoffice-data     ข้อมูล ONLYOFFICE
onlyoffice-logs     Log ของ ONLYOFFICE
onlyoffice-cache    Cache ของ ONLYOFFICE
rustfs-data         Private DOCX objects
caddy-data          Caddy certificates and state
caddy-config        Caddy runtime configuration
```

อย่าใช้ `docker compose down -v` หากไม่ได้ตั้งใจลบข้อมูลใน Database และ Docker volumes ทั้งหมด

## 8. Troubleshooting

### API ไม่ตอบ

```bash
docker compose --env-file .env.production -f compose.yaml ps
docker compose --env-file .env.production -f compose.yaml logs --tail=100 server
curl -f https://forms.example.test/health
curl -f https://forms.example.test/ready
```

`/health` เป็น liveness เท่านั้น. `/ready` จะคืน `503` จนกว่า PostgreSQL, RustFS health endpoint และ template ที่ bundle ใน Server image จะพร้อม. ตรวจว่ามี stack production เพียงชุดเดียวที่ใช้ port `80/443`.

### Editor บอกว่า Document ใช้งานไม่ได้

ตรวจว่า PostgreSQL, RustFS, `rustfs-init`, ONLYOFFICE และ Server เป็น `healthy`, `TEMPLATE_PATH` มีอยู่, `ONLYOFFICE_DOCUMENT_BASE_URL` ให้ ONLYOFFICE เรียก Server ได้ และ DNS ของ Forms/Office host ชี้มายัง Caddy.

### ไม่เห็นปุ่ม Save Draft หรือ Submit

ปุ่มของระบบไม่ได้อยู่บนหน้าเว็บโดยตรง ต้อง:

1. รอ ONLYOFFICE Editor โหลดเสร็จ
2. เปิดแท็บ **Form** ด้านบนของ ONLYOFFICE
3. ใช้ปุ่มที่ Plugin เพิ่มให้

### Form หายจาก Admin

สร้างและ Publish Form ผ่านหน้า Admin ก่อนเปิด Share Link

## 9. Production Compose operation

ใช้ `compose.yaml` เป็น topology เดียวสำหรับ production:

```bash
docker compose --env-file .env.production -f compose.yaml config --quiet
docker compose --env-file .env.production -f compose.yaml up -d --build
docker compose --env-file .env.production -f compose.yaml ps
docker compose --env-file .env.production -f compose.yaml logs --tail=100 server
```

มีเพียง Caddy ที่เปิด port `80/443` ภายนอก ส่วน Forms host route ไปยัง Web/API และ Office host route ไปยัง ONLYOFFICE PostgreSQL กับ RustFS ไม่มี public host port. `GET /health` เป็น liveness แบบตื้น และ `GET /ready` จะคืน `503` จนกว่า database, RustFS และไฟล์เตรียม Editor จะพร้อม.

ก่อนเริ่มระบบ Server จะรัน migration, bootstrap Admin แบบ create-only และ reconcile Handoff, pending claim, Editor Lease, Operation, callback claim และ cleanup intent ที่ค้างอยู่ การ restart ไม่ลบ Form, Draft, Submission, Prefill หรือ Audit Event ที่ commit แล้ว.

Mock ภายนอกไม่เริ่มใน production. หากต้องการ verification ให้เปิด profile `verification` เท่านั้น:

```bash
docker compose --env-file .env.production -f compose.yaml --profile verification up prefill-mock
```

Stack นี้ไม่มี application/off-host backup; disk, ransomware หรือ regional loss กู้คืนไม่ได้ และไม่ควรขยายเกินประมาณ 100 account, 100 Form และ editor พร้อมกัน 20 รายโดยไม่ตัดสินใจเรื่อง backup/scale ใหม่.

## 10. Source Reference

ข้อมูลในคู่มือนี้อ้างอิงจาก:

- `README.md`
- `CONTEXT.md`
- `apps/server/src/index.ts`
- `apps/server/src/storage.ts`
- `apps/server/src/onlyoffice.ts`
- `apps/onlyoffice-plugin/plugin.js`
- `packages/auth/src/index.ts`
- `packages/db/prisma/schema.prisma`
- `packages/env/src/server.ts`
- `compose.yaml`
- `Caddyfile`
- `apps/server/Dockerfile`
- `apps/web/Dockerfile`
