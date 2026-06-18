# Flow graph — `ImpersonationService.exchangeToken`

> Static outgoing-call graph via the `ts` provider (`trace graph`).
> **26** nodes · **28** edges · depth ≤ 4 · 20 external.
> Entry: `src/auth/impersonation/impersonation.service.ts:49:9` · root: `/Users/raunakburrows/hesta-dev/hesta-api`

## Call graph

```mermaid
flowchart TD
  N0["ImpersonationService.exchangeToken"]
  N1["Hash.digest"]
  N2["Hash.update"]
  N3["createHash"]
  N4["Repository.findOne"]
  N5["UnauthorizedException"]
  N6["Repository.remove"]
  N7["SessionService.createImpersonationSession"]
  N8["Logger.log"]
  N9["Repository.save"]
  N10["EncryptionService.encrypt"]
  N11["SessionService.key"]
  N12["SessionService.decryptSession"]
  N13["from"]
  N14["randomBytes"]
  N15["createCipheriv"]
  N16["Cipher.update"]
  N17["Cipher.final"]
  N18["getAuthTag"]
  N19["toString"]
  N20["ConfigService.getOrThrow"]
  N21["EncryptionService.decrypt"]
  N22["createDecipheriv"]
  N23["setAuthTag"]
  N24["Decipher.update"]
  N25["Decipher.final"]
  N0 -->|"×2"| N1
  N0 -->|"×4"| N2
  N0 -->|"×4"| N3
  N0 -->|"×2"| N4
  N0 -->|"×2"| N5
  N0 -->|"×4"| N6
  N0 -->|"×2"| N7
  N0 -->|"×2"| N8
  N7 -->|"×2"| N9
  N7 -->|"×6"| N10
  N7 -->|"×3"| N11
  N7 -->|"×2"| N4
  N7 -->|"×2"| N12
  N10 -->|"×2"| N13
  N10 --> N14
  N10 --> N15
  N10 -->|"×2"| N16
  N10 -->|"×2"| N17
  N10 -->|"×2"| N18
  N10 -->|"×4"| N19
  N11 -->|"×2"| N20
  N12 -->|"×6"| N21
  N12 -->|"×3"| N11
  N21 -->|"×6"| N13
  N21 --> N22
  N21 -->|"×2"| N23
  N21 -->|"×2"| N24
  N21 -->|"×2"| N25
  classDef entry fill:#d3f0ff,stroke:#0779a8,stroke-width:2px;
  classDef dep fill:#f0f0f0,stroke:#aaa,color:#666;
  classDef lib fill:#f7f7f7,stroke:#ccc,color:#999;
  class N1,N2,N3,N4,N5,N6,N8,N9,N13,N14,N15,N16,N17,N18,N19,N20,N22,N23,N24,N25 dep;
  class N0 entry;
```

_Rounded styling: blue = entry, grey = external dependency (`node_modules`), the rest is your code._

## Flow tree

```
graph — ImpersonationService.exchangeToken  (src/auth/impersonation/impersonation.service.ts:49)  via ts
  26 nodes · 28 edges · depth≤4 · 20 external

ImpersonationService.exchangeToken  src/auth/impersonation/impersonation.service.ts:49
├─ Hash.digest  ⊗ dep ×2
├─ Hash.update  ⊗ dep ×4
├─ createHash  ⊗ dep ×4
├─ Repository.findOne  ⊗ dep ×2
├─ UnauthorizedException  ⊗ dep ×2
├─ Repository.remove  ⊗ dep ×4
├─ SessionService.createImpersonationSession  src/auth/session/session.service.ts:85 ×2
│  ├─ Repository.save  ⊗ dep ×2
│  ├─ EncryptionService.encrypt  src/encryption/encryption.service.ts:10 ×6
│  │  ├─ from  ⊗ dep ×2
│  │  ├─ randomBytes  ⊗ dep
│  │  ├─ createCipheriv  ⊗ dep
│  │  ├─ Cipher.update  ⊗ dep ×2
│  │  ├─ Cipher.final  ⊗ dep ×2
│  │  ├─ getAuthTag  ⊗ dep ×2
│  │  └─ toString  ⊗ dep ×4
│  ├─ SessionService.key  src/auth/session/session.service.ts:22 ×3
│  │  └─ ConfigService.getOrThrow  ⊗ dep ×2
│  ├─ Repository.findOne  ⊗ dep ×2
│  └─ SessionService.decryptSession  src/auth/session/session.service.ts:104 ×2
│     ├─ EncryptionService.decrypt  src/encryption/encryption.service.ts:27 ×6
│     │  ├─ from  ⊗ dep ×6
│     │  ├─ createDecipheriv  ⊗ dep
│     │  ├─ setAuthTag  ⊗ dep ×2
│     │  ├─ Decipher.update  ⊗ dep ×2
│     │  └─ Decipher.final  ⊗ dep ×2
│     └─ SessionService.key  src/auth/session/session.service.ts:22 ×3  → shared
└─ Logger.log  ⊗ dep ×2
```

## Nodes

| Symbol | Kind | Location | Scope |
| --- | --- | --- | --- |
| `ImpersonationService.exchangeToken` | method | `src/auth/impersonation/impersonation.service.ts:49` | local |
| `Hash.digest` | method | _external_ | dep |
| `Hash.update` | method | _external_ | dep |
| `createHash` | function | _external_ | dep |
| `Repository.findOne` | method | _external_ | dep |
| `UnauthorizedException` | class | _external_ | dep |
| `Repository.remove` | method | _external_ | dep |
| `SessionService.createImpersonationSession` | method | `src/auth/session/session.service.ts:85` | local |
| `Logger.log` | method | _external_ | dep |
| `Repository.save` | method | _external_ | dep |
| `EncryptionService.encrypt` | method | `src/encryption/encryption.service.ts:10` | local |
| `SessionService.key` | getter | `src/auth/session/session.service.ts:22` | local |
| `SessionService.decryptSession` | method | `src/auth/session/session.service.ts:104` | local |
| `from` | method | _external_ | dep |
| `randomBytes` | function | _external_ | dep |
| `createCipheriv` | function | _external_ | dep |
| `Cipher.update` | method | _external_ | dep |
| `Cipher.final` | method | _external_ | dep |
| `getAuthTag` | method | _external_ | dep |
| `toString` | method | _external_ | dep |
| `ConfigService.getOrThrow` | method | _external_ | dep |
| `EncryptionService.decrypt` | method | `src/encryption/encryption.service.ts:27` | local |
| `createDecipheriv` | function | _external_ | dep |
| `setAuthTag` | method | _external_ | dep |
| `Decipher.update` | method | _external_ | dep |
| `Decipher.final` | method | _external_ | dep |
