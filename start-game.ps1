# Ricochet Rumble launcher for Windows.
# Starts a small local server (launcher/RicochetServer.cs) that serves the game
# to this computer at http://localhost and the Wi-Fi phone controller to phones
# on the same network, then opens the game in Chrome or Edge.
# If that server can't start, falls back to a localhost-only server so the game
# still runs with the Android app, keyboards and gamepads.
param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'

$root = Join-Path $PSScriptRoot 'game'

function Open-Game($url) {
  if ($NoBrowser) { return }
  try {
    $chrome = @(
      "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
      "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if ($chrome) { Start-Process $chrome $url } else { Start-Process "microsoft-edge:$url" }
  } catch {
    Write-Host "  Open $url in Chrome or Edge to play."
  }
}

# ---- normal mode: game + Wi-Fi phone server ----------------------------------------
$server = $null
try {
  $source = [IO.File]::ReadAllText((Join-Path (Join-Path $PSScriptRoot 'launcher') 'RicochetServer.cs'))
  Add-Type -TypeDefinition $source -Language CSharp
  $server = New-Object RicochetServer -ArgumentList $root
  if ($server.Start(8080, 8090) -lt 0) { throw 'no free port between 8080 and 8090' }
} catch {
  Write-Host ''
  Write-Host "  The Wi-Fi phone server couldn't start: $($_.Exception.Message)"
  Write-Host '  Starting in local-only mode instead (Android app, keyboards and gamepads still work).'
  $server = $null
}

if ($server) {
  $url = "http://localhost:$($server.Port)/"
  Write-Host ''
  Write-Host "  Ricochet Rumble is running at $url"
  $lan = $server.LanAddresses()
  if ($lan.Count -gt 0) {
    Write-Host "  Wi-Fi phones join at http://$($lan[0]):$($server.Port)/pad/ (or scan the QR code in the game lobby)"
    Write-Host '  If Windows asks whether to allow access, click "Allow" so phones can connect.'
  } else {
    Write-Host '  Not connected to a network yet, so Wi-Fi phones cannot join.'
  }
  Write-Host '  Keep this window open while you play. Close it to stop the game server.'
  Write-Host ''
  Open-Game $url
  $server.Run()
  exit
}

# ---- fallback: localhost-only static server -------------------------------------------
$rootFull = [IO.Path]::GetFullPath($root)
$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.ico'  = 'image/x-icon'
}
$listener = $null
foreach ($port in 8080..8090) {
  $candidate = New-Object System.Net.HttpListener
  $candidate.Prefixes.Add("http://localhost:$port/")
  try {
    $candidate.Start()
    $listener = $candidate
    break
  } catch {
    $candidate.Close()
  }
}
if (-not $listener) {
  Write-Host 'Could not open a local port between 8080 and 8090.'
  exit 1
}
$url = $listener.Prefixes | Select-Object -First 1
Write-Host ''
Write-Host "  Ricochet Rumble is running at $url (local-only mode)"
Write-Host '  Keep this window open while you play. Close it to stop the game server.'
Write-Host ''
Open-Game $url

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $res = $ctx.Response
  try {
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ($path.EndsWith('/')) { $path += 'index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $rootFull $path.TrimStart('/')))
    if ($file.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path $file -PathType Leaf)) {
      $bytes = [IO.File]::ReadAllBytes($file)
      $type = $mime[[IO.Path]::GetExtension($file).ToLower()]
      if (-not $type) { $type = 'application/octet-stream' }
      $res.ContentType = $type
      $res.Headers.Add('Cache-Control', 'no-cache')
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
    }
  } catch {
    $res.StatusCode = 500
  } finally {
    $res.Close()
  }
}
