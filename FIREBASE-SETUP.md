# Firebase einrichten — einmalig, ca. 20 Minuten

Ganz ohne CLI (die bräuchte Node.js, das auf diesem Rechner fehlt).
Alles passiert in der Browser-Konsole: <https://console.firebase.google.com>

Die Konsole übersetzt nicht alle Begriffe — manches bleibt auch auf Deutsch
englisch (z. B. „Firestore Database", „App Check"). Wo ich mir beim deutschen
Label nicht sicher bin, steht das englische Original in Klammern.

## 1. Projekt anlegen

- **„Projekt hinzufügen"** → Name z. B. `peatprobe` → Google Analytics **AUS**
  (wird nicht gebraucht)

## 2. Authentication (Anmeldung)

- Menü „Erstellen" (Build) → **Authentication** → „Jetzt starten"
- Tab **Anmeldemethode** (Sign-in method) → **Google** → Aktivieren →
  Support-E-Mail wählen → Speichern
- **Einstellungen → Autorisierte Domains → Domain hinzufügen:**
  - `DEIN-NUTZERNAME.github.io`   ← ohne diesen Eintrag schlägt die Anmeldung
    in der veröffentlichten App **stumm** fehl (kein Fehler, es passiert
    einfach nichts)
  - (`localhost` steht schon drin)

## 3. Firestore (Datenbank)

- „Erstellen" → **Firestore Database** → „Datenbank erstellen"
- Standort: **europe-west2 (London)** — lässt sich später **nicht** mehr
  ändern; UK-Standort passt zum Datenschutz-Gespräch mit Cambridge
- Im **Produktionsmodus** starten (production mode)
- Tab **Regeln** (Rules) → alles löschen → kompletten Inhalt von
  `firestore.rules` aus diesem Repo einfügen → **Veröffentlichen** (Publish)

## 4. Storage (Fotos)

- „Erstellen" → **Storage** → „Jetzt starten" → gleicher Standort
- Dabei fordert Firebase ein Upgrade auf den **Blaze-Tarif** (nutzungsbasiert;
  die Freikontingente reichen sehr wahrscheinlich aus, aber eine
  Kreditkarte muss hinterlegt werden)
- Tab **Regeln** → kompletten Inhalt von `storage.rules` einfügen →
  **Veröffentlichen**

## 5. Budgetwarnung — nicht überspringen!

- ⚙ → **Nutzung und Abrechnung** (Usage and billing) → Details & Einstellungen
  → **Budgetwarnung bei ca. 5 € einrichten**

## 6. Web-Konfiguration holen

- ⚙ → **Projekteinstellungen** → „Meine Apps" (Your apps) → **</>**-Symbol
  (Web) → Spitzname `peatprobe` → Firebase Hosting **nicht** ankreuzen →
  „App registrieren"
- Das angezeigte `firebaseConfig`-Objekt kopieren

## 7. In die App eintragen

In `js/config.js`: `FIREBASE.enabled = true` setzen und die Werte einfügen:

```js
export const FIREBASE = {
  enabled: true,
  config: {
    apiKey: '...',            // darf öffentlich sein - das ist eine Kennung,
    authDomain: '...',        // kein Geheimnis; die Sicherheit steckt in den
    projectId: '...',         // Regeln, nicht im Schlüssel
    storageBucket: '...',
    messagingSenderId: '...',
    appId: '...',
  },
};
```

## 8. Dich selbst zur Administratorin machen

1. Die App öffnen (deployed oder localhost) → **My data → Sync now** → mit
   deinem Google-Konto anmelden. Ab jetzt können Punkte synchronisieren.
2. Firebase-Konsole → Authentication → Tab **Nutzer** (Users) → deine
   **Nutzer-UID** (User UID) kopieren
3. Firestore → **„Sammlung starten"** (Start collection) → ID `admins` →
   Dokument-ID = *deine UID einfügen* → irgendein Feld anlegen
   (z. B. `note: "ich"`) → Speichern

Niemand sonst kann sich selbst eintragen: Die Regeln erlauben keinerlei
Schreibzugriff von Clients auf `admins`.

## Was du damit bekommst

- Freiwillige melden sich mit Google an; Messungen landen in der Sammlung
  `measurements` mit `status: pending_review`
- Fotos landen in Storage unter `photos/<fireId>/<uuid>.jpg`
- Wer das Feld-Paket eines Feuers herunterlädt, sieht alle synchronisierten
  Punkte aller Beteiligten für dieses Feuer
- Prüf-Warteschlange: Firestore-Konsole → nach `status == pending_review`
  filtern → auf `verified` ändern (laut Regeln nur für Admins möglich)

## Vor dem Freiwilligen-Start — noch offen

- **App Check** („Erstellen" → App Check, reCAPTCHA v3) — blockiert
  automatisierten Missbrauch des offenen Endpunkts. Danach die
  **Erzwingung** (enforcement) für Firestore + Storage aktivieren.
- Datenschutzerklärung + Gespräch mit dem Datenschutzbüro in Cambridge.
