# Folio Forms — คู่มือใช้งาน Local Development

Folio Forms เป็นระบบสร้างและกรอกแบบฟอร์ม DOCX โดยใช้ ONLYOFFICE เป็น Document Editor

- **Admin** สร้าง Template, กำหนด Field, Publish และดู Submission
- **User** เปิดลิงก์แบบฟอร์ม, กรอกข้อมูล, Save Draft, Resume และ Submit
- **API** รันด้วย Bun + Elysia ที่ port `3000`
- **Web** รันด้วย React + Vite ที่ port `5173`
- **ONLYOFFICE Docs** รันใน Docker ที่ port `8080`
- **PostgreSQL** รันใน Docker ที่ port `5432`

เอกสารนี้ใช้สำหรับ local prototype เท่านั้น ไม่ควรนำค่า Credentials และ Secret ในตัวอย่างไปใช้บนระบบจริง

## 1. การรัน Development Mode

โหมดที่แนะนำคือให้ PostgreSQL และ ONLYOFFICE อยู่ใน Docker แต่ให้ API และ Web รันบนเครื่องด้วย Bun

### 1.1 เตรียม Environment ครั้งแรก

ถ้ายังไม่มีไฟล์ `apps/server/.env` ให้สร้างจากไฟล์ตัวอย่าง:

```bash
cp apps/server/.env.example apps/server/.env
```

จากนั้นเปลี่ยนค่า `BETTER_AUTH_SECRET` เป็นค่าสุ่มที่ยาวอย่างน้อย 32 ตัวอักษร ห้ามแชร์ค่านี้

ไฟล์ที่เกี่ยวข้อง:

```text
apps/server/.env          ค่าที่ใช้จริงในเครื่อง และไม่ควร commit
apps/server/.env.example  ตัวอย่างค่าที่ต้องใช้
```

### 1.2 เริ่ม PostgreSQL และ ONLYOFFICE

ถ้า Container ทำงานอยู่แล้ว ให้ข้ามคำสั่งนี้ได้:

```bash
docker compose -f compose.yaml up -d postgres onlyoffice
```

ใช้ `compose.yaml` โดยระบุ `-f` เสมอ เพราะ repository มี `docker-compose.yml` อีกไฟล์หนึ่งที่เป็นไฟล์เก่าและมีเฉพาะ Server

### 1.3 ติดตั้งและเตรียมฐานข้อมูล

```bash
bun install
bun run --cwd apps/server db:migrate
bun run --cwd apps/server db:seed
```

คำสั่ง `db:seed` จะสร้างหรือซ่อมข้อมูล Demo แบบ idempotent ได้แก่:

- Demo accounts 3 บัญชี
- Prefill profile ของแต่ละ User
- Form `demo-employee-intake`
- Template Draft และ Published Template ของ Demo form

การรัน Seed ซ้ำจะไม่ลบ Form หรือ Submission เดิม และถ้าบัญชีมีอยู่แล้วจะไม่เปลี่ยน Password เดิม

### 1.4 รัน API และ Web

```bash
bun run dev
```

คำสั่งนี้ใช้ Turborepo เปิดทั้ง:

```text
API: http://localhost:3000
Web: http://localhost:5173
```

ตรวจ API ได้ด้วย:

```bash
curl http://localhost:3000/health
```

ผลลัพธ์ที่ถูกต้อง:

```json
{"ok":true}
```

จากนั้นเปิดเว็บ:

```text
http://localhost:5173
```

หยุด Development server ด้วย:

```text
Ctrl+C
```

ไม่ต้องหยุด PostgreSQL หรือ ONLYOFFICE หากยังต้องการใช้ต่อ

### 1.5 ห้ามรัน API สองโหมดพร้อมกัน

ห้ามรันคำสั่งเหล่านี้พร้อมกัน:

```bash
bun run dev
```

และ:

```bash
docker compose -f compose.yaml up -d --build server
```

ทั้งสองแบบใช้ port `3000` เหมือนกัน ให้เลือกเพียงแบบใดแบบหนึ่ง

## 2. Accounts

### 2.1 Application accounts

ระบบยังไม่มีหน้า Registration ให้ใช้บัญชีที่ Seed ไว้:

| Role | Email | Password | Prefill |
| --- | --- | --- | --- |
| Admin | `admin@example.com` | `AdminPassword123!` | Demo Admin / finance / 2024-01-15 |
| User | `user-a@example.com` | `UserAPassword123!` | User A / hr / 2024-02-01 |
| User | `user-b@example.com` | `UserBPassword123!` | User B / engineering / 2024-03-01 |

Credentials เหล่านี้ใช้สำหรับ local demo เท่านั้น

### 2.2 สิทธิ์ของแต่ละ Role

#### Admin

- เข้า `/admin`
- สร้าง Form ใหม่
- ลบ Form ที่ยังเป็น Draft และยังไม่มี Response
- แก้ไข DOCX Template
- Save Template
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

### 2.3 บัญชีอยู่ที่ไหน

Demo accounts ถูกประกาศและสร้างใน:

```text
apps/server/src/seed.ts
```

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
```

Password จริงในฐานข้อมูลถูกจัดการโดย Better Auth ไม่ได้เก็บเป็น Plain Text

Browser เก็บ Bearer session token ที่:

```text
localStorage["onlyoffice.sessionToken"]
```

ไม่ควรเปิดดูหรือแชร์ Token นี้

## 3. ทดลองใช้งานในฐานะ User

ลิงก์ Demo:

```text
http://localhost:5173/forms/demo-employee-intake/fill
```

1. เปิดลิงก์ Demo
2. Login ด้วยบัญชี User เช่น:

   ```text
   Email:    user-a@example.com
   Password: UserAPassword123!
   ```

3. รอ ONLYOFFICE Editor โหลด
4. ตรวจข้อมูลที่ระบบ Prefill ให้
5. เปิดแท็บ **Form** ด้านบนของ ONLYOFFICE
6. กรอก Field ที่ยังว่าง
7. กด **Save Draft** ในแท็บ Form
8. รอข้อความว่าการบันทึกเสร็จสมบูรณ์
9. กด **Exit**
10. กลับไปที่ Dashboard
11. กด **Resume** เพื่อกรอกต่อ
12. เมื่อกรอกเสร็จ เปิดแท็บ **Form** อีกครั้ง
13. กด **Submit**
14. รอให้ระบบประมวลผลเสร็จ
15. ระบบจะเปิดหน้า Receipt

### 3.1 Field ของ Demo Form

| Tag | ความหมาย | นโยบายของ Demo User |
| --- | --- | --- |
| `full_name` | ชื่อเต็ม | Prefill และล็อกไม่ให้แก้ |
| `department` | แผนก | Prefill และล็อกไม่ให้แก้ |
| `start_date` | วันที่เริ่มงาน | Prefill แต่แก้ไขได้ |
| `accept_terms` | ยอมรับเงื่อนไข | User กรอกเอง |
| `description_1` | รายละเอียดส่วนที่หนึ่ง | User กรอกเอง |
| `description_2` | รายละเอียดส่วนที่สอง | User กรอกเอง |

การกด Save Draft หรือ Submit ต้องกดจาก **แท็บ Form ใน ONLYOFFICE** ไม่ใช่ปุ่ม Save ปกติของ Word

เมื่อ Submit สำเร็จ User จะเห็น Receipt และสามารถดาวน์โหลด:

```text
filled.docx
filled.pdf
data.json
```

## 4. ทดลองใช้งานในฐานะ Admin

1. เปิด `http://localhost:5173/login`
2. Login ด้วย:

   ```text
   Email:    admin@example.com
   Password: AdminPassword123!
   ```

3. ระบบจะพาไปที่ `/admin`
4. กด **New form**
5. กรอก Title และ Description
6. กด **Create draft**
7. ระบบจะเปิด ONLYOFFICE Editor

### 4.1 ออกแบบ Template

ใน DOCX ต้องใช้ ONLYOFFICE Content Controls และตั้ง Tag ให้ทุก Field

กฎสำคัญ:

- ทุก Content Control ต้องมี Tag
- Tag ต้องไม่ซ้ำกันใน Form เดียวกัน
- Tag เป็นชื่อที่ใช้ใน JSON และ Prefill
- Tag ควรเป็นชื่อที่สื่อความหมาย เช่น `full_name`

เมื่อแก้ไข Template เสร็จ:

1. เปิดแท็บ **Form** ใน ONLYOFFICE
2. กด **Save Template**
3. รอให้การบันทึกเสร็จ
4. กด **Publish**
5. กด **Copy link** เพื่อคัดลอก Share Link
6. ส่งลิงก์ให้ User ทดลองกรอก

หน้า Admin ยังมีปุ่มด้านบนด้วย:

- **Save template** — บันทึก Template Draft แต่ยังไม่เปลี่ยน Form ที่แชร์
- **Publish** — ทำให้ Template นี้เป็น Published Template สำหรับ Response ใหม่

### 4.2 ผลของการ Publish

การ Publish Template เวอร์ชันใหม่จะ:

- เปลี่ยนเอกสารที่ใช้เริ่ม Response ใหม่
- ทำให้ Draft ที่ยังไม่ Submit ของ Form นั้นใช้ต่อไม่ได้
- ไม่เปลี่ยน Submission ที่เสร็จแล้ว

ถ้ามี Draft ค้างอยู่ ระบบจะแสดงคำเตือนก่อน Publish

### 4.3 ดู Submission

จากหน้า Form editor กด:

```text
View submissions
```

Admin จะสามารถดูข้อมูล, เปิด Receipt และดาวน์โหลด DOCX/PDF ได้

## 5. URL สำคัญ

| URL | ใช้งาน |
| --- | --- |
| `http://localhost:5173` | หน้าเริ่มต้น |
| `http://localhost:5173/login` | Login |
| `http://localhost:5173/dashboard` | Dashboard ของ User |
| `http://localhost:5173/admin` | Dashboard ของ Admin |
| `http://localhost:5173/admin/forms/new` | สร้าง Form |
| `http://localhost:5173/forms/demo-employee-intake/fill` | Demo Share Link |
| `http://localhost:3000/health` | ตรวจ API |
| `http://localhost:8080` | ONLYOFFICE Document Server |

ถ้าเปิด Share Link โดยยังไม่ Login ระบบจะพาไป `/login` ก่อน แล้วกลับมายัง Form เดิมหลัง Login สำเร็จ

## 6. ไฟล์สำคัญใน Repository

```text
apps/
  server/
    src/index.ts       API routes และ workflow หลัก
    src/seed.ts        Demo accounts, profiles และ Demo form
    src/storage.ts     ตรวจสอบและเขียน Artifact
    src/onlyoffice.ts  Document URL, HMAC, force-save และ PDF conversion
    .env               Environment local จริง

  web/
    src/routes/        หน้า Login, Dashboard, Admin, Fill และ Receipt
    src/components/
      onlyoffice-editor.tsx  ฝัง ONLYOFFICE ในหน้าเว็บ
    src/lib/
      api.ts            API client และ session token

  onlyoffice-plugin/
    index.html          Plugin entrypoint
    plugin.js           Form tab, Prefill, Extract, Save Draft และ Submit

packages/
  auth/
    src/index.ts        Better Auth configuration
  db/
    src/schema.ts       PostgreSQL schema
    migrations/         SQL migrations
  env/
    src/server.ts       ตรวจสอบ Environment variables

onlyoffice-templates/
  template.docx         Template DOCX ต้นฉบับ

onlyoffice-submissions/
  forms/                 Template Draft และ Published Template
  responses/             Draft ของ User
  submissions/           DOCX/PDF/JSON หลัง Submit
```

## 7. ที่เก็บข้อมูลและ Artifact

### 7.1 PostgreSQL

ตาราง Application หลัก:

```text
forms              Form, public ID, status, version และ path ของ Template
prefill_profiles   Prefill data และนโยบาย Field ที่แก้ไขได้
prefill_snapshots  ค่าที่ถูก snapshot ตอนเริ่ม Response
responses          Response ของ User และ Draft data
submissions        ข้อมูล Submit แบบแก้ไขไม่ได้ และ path ของ Artifact
operations         สถานะงาน Save, Publish, Draft และ Submit แบบ asynchronous
```

### 7.2 ไฟล์ Artifact

Host API mode ใช้โฟลเดอร์:

```text
onlyoffice-submissions/
```

โครงสร้างโดยทั่วไป:

```text
onlyoffice-submissions/
  forms/
    <formId>/
      template-draft.docx
      published-1.docx

  responses/
    <responseId>/
      draft-v1.docx
      draft-<operationId>.docx

  submissions/
    <submissionId>/
      filled.docx
      filled.pdf
      data.json
```

ระหว่างการประมวลผลอาจมีไฟล์ชั่วคราวที่:

```text
operations/<operationId>/
```

Database เก็บ Relative path เช่น `submissions/<submissionId>/filled.pdf` ไม่ได้เก็บ Absolute path ของเครื่อง

`onlyoffice-submissions/` เป็น Runtime data และถูก ignore โดย Git

### 7.3 Docker volumes

```text
postgres-data-v18   ข้อมูล PostgreSQL
onlyoffice-data     ข้อมูล ONLYOFFICE
onlyoffice-logs     Log ของ ONLYOFFICE
onlyoffice-cache    Cache ของ ONLYOFFICE
```

อย่าใช้ `docker compose down -v` หากไม่ได้ตั้งใจลบข้อมูลใน Database และ Docker volumes ทั้งหมด

## 8. Troubleshooting

### API ไม่ตอบ

```bash
curl http://localhost:3000/health
docker compose -f compose.yaml ps
```

ถ้า port `3000` ถูกใช้งานอยู่ ให้ตรวจว่าไม่ได้เปิด Compose `server` พร้อมกับ Host API

### Editor บอกว่า Document ใช้งานไม่ได้

ตรวจว่า:

1. PostgreSQL ทำงานอยู่
2. ONLYOFFICE เปิดที่ `http://localhost:8080`
3. API ตอบที่ `http://localhost:3000`
4. `apps/server/.env` มี `ONLYOFFICE_DOCUMENT_BASE_URL=http://host.docker.internal:3000`
5. `STORAGE_ROOT` ชี้ไปยังโฟลเดอร์ที่เขียนได้
6. ใช้ Host API mode หรือ Compose API mode เพียงแบบเดียว

ถ้า Demo form หรือ Artifact หาย ให้รัน:

```bash
bun run --cwd apps/server db:seed
```

### ไม่เห็นปุ่ม Save Draft หรือ Submit

ปุ่มของระบบไม่ได้อยู่บนหน้าเว็บโดยตรง ต้อง:

1. รอ ONLYOFFICE Editor โหลดเสร็จ
2. เปิดแท็บ **Form** ด้านบนของ ONLYOFFICE
3. ใช้ปุ่มที่ Plugin เพิ่มให้

### Form หายจาก Admin

Seed ไม่ได้ลบ Form เก่าออก ให้ตรวจรายการ Form ใน `/admin` และฐานข้อมูลก่อนรันคำสั่งลบใด ๆ

## 9. โหมด Compose API ทางเลือก

ถ้าต้องการให้ API รันใน Docker ทั้งหมด ให้หยุด Host API ก่อน แล้วใช้:

```bash
docker compose -f compose.yaml up -d --build postgres onlyoffice server
bun run --cwd apps/web dev
```

ในโหมดนี้ Container `server` จะทำสิ่งต่อไปนี้เอง:

1. Run migration
2. Run seed
3. Start API ที่ port `3000`
4. Mount `./onlyoffice-submissions` เข้า `/app/onlyoffice-submissions`

อย่าใช้โหมดนี้พร้อมกับ `bun run dev` เพราะจะชน port `3000`

## 10. Source Reference

ข้อมูลในคู่มือนี้อ้างอิงจาก:

- `README.md`
- `CONTEXT.md`
- `apps/server/src/seed.ts`
- `apps/server/src/index.ts`
- `apps/server/src/storage.ts`
- `apps/server/src/onlyoffice.ts`
- `apps/onlyoffice-plugin/plugin.js`
- `packages/auth/src/index.ts`
- `packages/db/src/schema.ts`
- `packages/env/src/server.ts`
- `compose.yaml`
