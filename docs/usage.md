# Folio Forms — คู่มือใช้งาน Local Development

Folio Forms เป็นระบบสร้างและกรอกแบบฟอร์ม DOCX โดยใช้ ONLYOFFICE เป็น Document Editor

- **Admin** สร้าง Template, กำหนด Field, Publish และดู Submission
- **User** เปิดลิงก์แบบฟอร์ม, กรอกข้อมูล, Save Draft, Resume และ Submit
- **API** รันด้วย Bun + Elysia ที่ port `3000`
- **Web** รันด้วย React + Vite ที่ port `5173`
- **ONLYOFFICE Docs** รันใน Docker ที่ port `8080`
- **PostgreSQL** รันใน Docker ที่ port `5432`

เอกสารนี้อธิบายการรันระบบ MMVP, การใช้ Share Link, การจัดการ Form และตำแหน่งข้อมูลสำคัญ

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

### 1.3 Apply Prisma migration

เปิด Terminal B:

```bash
bun run --cwd packages/db db:generate
bun run --cwd apps/server db:migrate
```

Migration เริ่มต้นรองรับ PostgreSQL ว่างและสร้าง schema ที่ระบบต้องใช้ ไม่มีการ seed บัญชีหรือข้อมูล demo

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

การติดตั้งใหม่สร้าง Admin คนแรกจากค่า bootstrap เมื่อยังไม่มี Admin เท่านั้น หลังจากนั้น Admin สร้างและจัดการบัญชีทั้งหมด ระบบไม่มี public sign-up, บัญชี demo หรือรหัสผ่านคงที่

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
```

Password จริงในฐานข้อมูลถูกจัดการโดย Better Auth ไม่ได้เก็บเป็น Plain Text

Browser เก็บ Bearer session token ที่:

```text
localStorage["onlyoffice.sessionToken"]
```

ไม่ควรเปิดดูหรือแชร์ Token นี้

## 3. ทดลองใช้งานในฐานะ User

1. เปิด Share Link ที่ Admin คัดลอกจาก Form ที่ Publish แล้ว
2. Login ด้วยบัญชี User ที่ provision ไว้
3. ตรวจค่า Prefill และ Field ที่ถูก lock
4. กด **Save Draft** เพื่อบันทึกและกลับมาทำต่อ
5. กด **Submit** เพื่อสร้าง Submission แบบ immutable
6. เปิด Receipt จาก Dashboard
7. ดาวน์โหลด DOCX หรือขอ PDF export เมื่อจำเป็น

Share Link เป็น opaque public ID ที่ระบบสร้างให้แต่ละ Form ไม่มีค่า demo แบบคงที่

## 4. ทดลองใช้งานในฐานะ Admin

1. เปิด `http://localhost:5173/login`
2. Login ด้วยบัญชีที่ถูก provision เป็น role `Admin`
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
| `http://localhost:3000/health` | ตรวจ API |
| `http://localhost:8080` | ONLYOFFICE Document Server |

ถ้าเปิด Share Link โดยยังไม่ Login ระบบจะพาไป `/login` ก่อน แล้วกลับมายัง Form เดิมหลัง Login สำเร็จ

## 6. ไฟล์สำคัญใน Repository

```text
apps/
  server/
    src/app.ts         API routes และ workflow หลัก
    src/index.ts       Production listen entrypoint
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
    prisma/schema.prisma  Prisma schema
    prisma/migrations/   SQL migrations ที่ checked in
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
Form / TemplateDraft / PublishedTemplate / FieldManifest
PrefillConfiguration / PrefillSnapshot
Response / Submission / Correction
Handoff / PendingClaim
Operation / CallbackClaim / EditorLease
AuditEvent / LoginFailure / DeletionTombstone
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
```

ระหว่างการประมวลผลอาจมีไฟล์ชั่วคราวที่:

```text
operations/<operationId>/
```

Database เก็บ object key แบบ relative ไม่ได้เก็บ Absolute path ของเครื่อง

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


### ไม่เห็นปุ่ม Save Draft หรือ Submit

ปุ่มของระบบไม่ได้อยู่บนหน้าเว็บโดยตรง ต้อง:

1. รอ ONLYOFFICE Editor โหลดเสร็จ
2. เปิดแท็บ **Form** ด้านบนของ ONLYOFFICE
3. ใช้ปุ่มที่ Plugin เพิ่มให้

### Form หายจาก Admin

สร้างและ Publish Form ผ่านหน้า Admin ก่อนเปิด Share Link

## 9. โหมด Compose API ทางเลือก

ถ้าต้องการให้ API รันใน Docker ทั้งหมด ให้หยุด Host API ก่อน แล้วใช้:

```bash
docker compose -f compose.yaml up -d --build postgres onlyoffice server
bun run --cwd apps/web dev
```

ในโหมดนี้ Container `server` จะทำสิ่งต่อไปนี้เอง:

1. Run migration
2. Start API ที่ port `3000`
3. Mount `./onlyoffice-submissions` เข้า `/app/onlyoffice-submissions`

อย่าใช้โหมดนี้พร้อมกับ `bun run dev` เพราะจะชน port `3000`

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
