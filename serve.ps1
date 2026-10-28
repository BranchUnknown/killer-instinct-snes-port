# Tiny local web server for the KI port (no install needed): serves this folder at
# http://localhost:8642/ and opens the browser. Running from a web address (instead of opening the
# file directly) lets the browser keep saved data (ROM, battery saves, stage pictures) and lets the
# port find the MegaPatch folder and your ROM next to index.html by itself.
# /__list?dir=sub/folder returns the files and folders there as JSON.
param([int]$Port = 8642, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Types = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css'; '.png'='image/png';
  '.json'='application/json'; '.md'='text/plain; charset=utf-8'; '.txt'='text/plain; charset=utf-8' }

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
try { $listener.Start() } catch { Write-Host "Port $Port is busy - the server may already be running."; Start-Process "http://localhost:$Port/index.html"; exit }
Write-Host "Killer Instinct port: http://localhost:$Port/  (close this window to stop)"
if (-not $NoBrowser) { Start-Process "http://localhost:$Port/index.html" }

function Send($stream, [int]$code, [string]$type, [byte[]]$body, [long]$length, [string]$file, [bool]$head) {
  $reason = @{ 200='OK'; 404='Not Found'; 403='Forbidden' }[$code]
  $h = "HTTP/1.1 $code $reason`r`nContent-Type: $type`r`nContent-Length: $length`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
  $hb = [System.Text.Encoding]::ASCII.GetBytes($h)
  $stream.Write($hb, 0, $hb.Length)
  if ($head) { return }
  if ($body) { $stream.Write($body, 0, $body.Length) }
  elseif ($file) { $fs = [System.IO.File]::OpenRead($file); try { $fs.CopyTo($stream, 1048576) } finally { $fs.Close() } }
}

while ($true) {
  $client = $listener.AcceptTcpClient()
  $client.ReceiveTimeout = 1500; $client.SendTimeout = 30000   # browsers open idle "preconnect" sockets
  try {
    $stream = $client.GetStream()
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 4096, $true)
    $line = $reader.ReadLine()
    while ($true) { $l = $reader.ReadLine(); if ($l -eq $null -or $l -eq '') { break } }
    if (-not $line) { continue }
    $parts = $line.Split(' ')
    $method = $parts[0]; $target = [System.Uri]::UnescapeDataString($parts[1])
    $head = $method -eq 'HEAD'
    $path = $target.Split('?')[0]; $query = if ($target.Contains('?')) { $target.Substring($target.IndexOf('?') + 1) } else { '' }
    if ($path -eq '/__list') {
      $sub = ''; foreach ($kv in $query.Split('&')) { if ($kv.StartsWith('dir=')) { $sub = $kv.Substring(4) } }
      $dir = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($Root, $sub.TrimStart('/')))
      if (-not $dir.StartsWith($Root) -or -not (Test-Path -LiteralPath $dir -PathType Container)) { $json = '{"files":[],"dirs":[]}' }
      else {
        $files = @(Get-ChildItem -LiteralPath $dir -File | ForEach-Object { '"' + ($_.Name -replace '\\','\\' -replace '"','\"') + '"' }) -join ','
        $dirs = @(Get-ChildItem -LiteralPath $dir -Directory | ForEach-Object { '"' + ($_.Name -replace '\\','\\' -replace '"','\"') + '"' }) -join ','
        $json = '{"files":[' + $files + '],"dirs":[' + $dirs + ']}'
      }
      $b = [System.Text.Encoding]::UTF8.GetBytes($json)
      Send $stream 200 'application/json' $b $b.Length $null $head
      continue
    }
    if ($path -eq '/') { $path = '/index.html' }
    # /arcade/... = the extracted / upscaled arcade art (ki-arcade/out/art next to this project), for the
    # "Arcade art" option (js/arcadeart.js)
    if ($path.StartsWith('/arcade/')) {
      $ArtRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($Root, '..\..\ki-arcade\out\art'))
      $file = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($ArtRoot, $path.Substring(8)))
      if (-not $file.StartsWith($ArtRoot) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { $b = [System.Text.Encoding]::ASCII.GetBytes('not found'); Send $stream 404 'text/plain' $b $b.Length $null $head; continue }
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      $type = if ($Types.ContainsKey($ext)) { $Types[$ext] } else { 'application/octet-stream' }
      Send $stream 200 $type $null (Get-Item -LiteralPath $file).Length $file $head
      continue
    }
    $file = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($Root, $path.TrimStart('/')))
    if (-not $file.StartsWith($Root)) { $b = [byte[]]@(); Send $stream 403 'text/plain' $b 0 $null $head; continue }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { $b = [System.Text.Encoding]::ASCII.GetBytes('not found'); Send $stream 404 'text/plain' $b $b.Length $null $head; continue }
    $ext = [System.IO.Path]::GetExtension($file).ToLower()
    $type = if ($Types.ContainsKey($ext)) { $Types[$ext] } else { 'application/octet-stream' }
    Send $stream 200 $type $null (Get-Item -LiteralPath $file).Length $file $head
  } catch { } finally { $client.Close() }
}
