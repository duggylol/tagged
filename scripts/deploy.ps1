<#
  Tagged — one-shot Vercel deploy.

  Run from the repo root:

      powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1

  What it does:
    1. Signs you in to Vercel (opens a browser once).
    2. Links this folder to a Vercel project.
    3. Sets every environment variable in production.
    4. Deploys, then sets NEXT_PUBLIC_APP_URL to the live URL and redeploys.

  The two secrets it prompts for are typed straight into the Vercel CLI on
  your machine — they are never written to disk and never leave it.
#>

$ErrorActionPreference = 'Stop'

# --- Values already provisioned -------------------------------------------
# The URL and publishable key are safe in source — the publishable key is
# designed to ship to browsers and every table behind it is protected by RLS.
$SupabaseUrl     = 'https://ilbanwcmekfaplmffphe.supabase.co'
$SupabaseAnonKey = 'sb_publishable_LV65F8XWrsXGud3BjZ6NwQ_y0VH_HBu'
$ProjectName     = 'tagged'

# CRON_SECRET is a real secret, so it is generated here rather than committed.
# Re-running this script mints a new one, which is fine — Vercel reads the
# current value when it fires the cron.
$CronSecret = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })

function Write-Step($text) { Write-Host "`n=== $text" -ForegroundColor Green }

# --- 1. Auth ---------------------------------------------------------------
Write-Step 'Checking Vercel sign-in'
$whoami = npx --yes vercel@latest whoami 2>&1 | Out-String
if ($whoami -match 'not valid|Error') {
  Write-Host 'Signing in — a browser window will open.' -ForegroundColor Yellow
  npx --yes vercel@latest login
  if ($LASTEXITCODE -ne 0) { throw 'Vercel sign-in failed.' }
} else {
  Write-Host "Already signed in as $($whoami.Trim())"
}

# --- 2. Link ---------------------------------------------------------------
Write-Step 'Linking this folder to a Vercel project'
npx --yes vercel@latest link --yes --project $ProjectName
if ($LASTEXITCODE -ne 0) { throw 'Could not link the project.' }

# --- 3. Secrets ------------------------------------------------------------
Write-Step 'Two secrets are needed'
Write-Host 'Supabase service role key:'
Write-Host '  https://supabase.com/dashboard/project/ilbanwcmekfaplmffphe/settings/api-keys' -ForegroundColor Cyan
Write-Host '  Copy the "service_role" / secret key (NOT the publishable one).'
$serviceRole = Read-Host -AsSecureString 'Paste it here'
$serviceRolePlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($serviceRole))

Write-Host "`nGemini API key (free to create):"
Write-Host '  https://aistudio.google.com/apikey' -ForegroundColor Cyan
Write-Host '  Leave blank to skip — everything except AI analysis will still work.'
$gemini = Read-Host -AsSecureString 'Paste it here'
$geminiPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($gemini))

# --- 4. Environment --------------------------------------------------------
function Set-VercelEnv($name, $value) {
  if ([string]::IsNullOrWhiteSpace($value)) {
    Write-Host "  skipped $name (empty)" -ForegroundColor DarkGray
    return
  }
  # Remove first so a re-run updates rather than erroring on a duplicate.
  npx --yes vercel@latest env rm $name production --yes 2>$null | Out-Null
  $value | npx --yes vercel@latest env add $name production | Out-Null
  Write-Host "  set $name" -ForegroundColor DarkGray
}

Write-Step 'Setting production environment variables'
Set-VercelEnv 'NEXT_PUBLIC_SUPABASE_URL'      $SupabaseUrl
Set-VercelEnv 'NEXT_PUBLIC_SUPABASE_ANON_KEY' $SupabaseAnonKey
Set-VercelEnv 'SUPABASE_SERVICE_ROLE_KEY'     $serviceRolePlain
Set-VercelEnv 'CRON_SECRET'                   $CronSecret
Set-VercelEnv 'GEMINI_API_KEY'                $geminiPlain
Set-VercelEnv 'AI_VISION_PROVIDER'            'gemini'
Set-VercelEnv 'AI_COPY_PROVIDER'              'gemini'
Set-VercelEnv 'AI_VISION_MODEL'               'gemini-2.5-flash-lite'
Set-VercelEnv 'AI_COPY_MODEL'                 'gemini-2.5-flash-lite'
Set-VercelEnv 'AI_MONTHLY_BUDGET_USD'         '2.00'

# --- 5. Deploy -------------------------------------------------------------
Write-Step 'Deploying to production'
$deployOutput = npx --yes vercel@latest deploy --prod --yes 2>&1 | Out-String
Write-Host $deployOutput

$url = ([regex]::Matches($deployOutput, 'https://[a-z0-9\-]+\.vercel\.app') |
        Select-Object -Last 1).Value

if (-not $url) { throw 'Deployment finished but no URL was found in the output.' }

# --- 6. Point the app at itself -------------------------------------------
# NEXT_PUBLIC_APP_URL builds the phone-pairing QR link, so it has to be the
# real origin — which is only known after the first deploy.
Write-Step "Setting NEXT_PUBLIC_APP_URL to $url and redeploying"
Set-VercelEnv 'NEXT_PUBLIC_APP_URL' $url
npx --yes vercel@latest deploy --prod --yes | Out-Null

Write-Host "`n────────────────────────────────────────────" -ForegroundColor Green
Write-Host " Tagged is live: $url" -ForegroundColor Green
Write-Host "────────────────────────────────────────────`n" -ForegroundColor Green
Write-Host 'Next: open the URL, create an account, then go to Capture and scan the QR with your phone.'
Write-Host 'Add your Supabase redirect URL so email confirmation works:'
Write-Host "  https://supabase.com/dashboard/project/ilbanwcmekfaplmffphe/auth/url-configuration" -ForegroundColor Cyan
Write-Host "  Site URL: $url"
