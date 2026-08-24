param(
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"
$Root = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$Address = [System.Net.IPAddress]::Loopback
$Listener = [System.Net.Sockets.TcpListener]::new($Address, $Port)

function Get-MimeType([string]$Path) {
    switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
        ".html" { "text/html; charset=utf-8" }
        ".css"  { "text/css; charset=utf-8" }
        ".js"   { "application/javascript; charset=utf-8" }
        ".json" { "application/json; charset=utf-8" }
        ".png"  { "image/png" }
        ".jpg"  { "image/jpeg" }
        ".jpeg" { "image/jpeg" }
        ".svg"  { "image/svg+xml" }
        ".ico"  { "image/x-icon" }
        default  { "application/octet-stream" }
    }
}

function Send-Response($Stream, [int]$StatusCode, [string]$StatusText, [byte[]]$Body, [string]$ContentType) {
    $Header = "HTTP/1.1 $StatusCode $StatusText`r`n" +
              "Content-Type: $ContentType`r`n" +
              "Content-Length: $($Body.Length)`r`n" +
              "Cache-Control: no-cache`r`n" +
              "Connection: close`r`n`r`n"
    $HeaderBytes = [System.Text.Encoding]::ASCII.GetBytes($Header)
    $Stream.Write($HeaderBytes, 0, $HeaderBytes.Length)
    if ($Body.Length -gt 0) {
        $Stream.Write($Body, 0, $Body.Length)
    }
    $Stream.Flush()
}

try {
    $Listener.Start()
    Write-Host ""
    Write-Host "CGO Music iniciado correctamente." -ForegroundColor Green
    Write-Host "Direccion: http://localhost:$Port/"
    Write-Host "Deja esta ventana abierta mientras uses la aplicacion."
    Write-Host "Para detener el servidor presiona Ctrl+C."
    Write-Host ""

    Start-Process "http://localhost:$Port/"

    while ($true) {
        $Client = $Listener.AcceptTcpClient()
        try {
            $Stream = $Client.GetStream()
            $Reader = New-Object System.IO.StreamReader($Stream, [System.Text.Encoding]::ASCII, $false, 4096, $true)
            $RequestLine = $Reader.ReadLine()
            if ([string]::IsNullOrWhiteSpace($RequestLine)) {
                continue
            }

            while ($true) {
                $Line = $Reader.ReadLine()
                if ([string]::IsNullOrEmpty($Line)) { break }
            }

            $Parts = $RequestLine.Split(' ')
            if ($Parts.Length -lt 2) {
                continue
            }

            $UrlPath = $Parts[1].Split('?')[0]
            $Relative = [System.Uri]::UnescapeDataString($UrlPath).TrimStart('/')
            if ([string]::IsNullOrWhiteSpace($Relative)) {
                $Relative = "index.html"
            }

            $Candidate = [System.IO.Path]::GetFullPath((Join-Path $Root $Relative))
            if (-not $Candidate.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
                $Body = [System.Text.Encoding]::UTF8.GetBytes("403 Forbidden")
                Send-Response $Stream 403 "Forbidden" $Body "text/plain; charset=utf-8"
                continue
            }

            if ([System.IO.Directory]::Exists($Candidate)) {
                $Candidate = Join-Path $Candidate "index.html"
            }

            if ([System.IO.File]::Exists($Candidate)) {
                $Body = [System.IO.File]::ReadAllBytes($Candidate)
                Send-Response $Stream 200 "OK" $Body (Get-MimeType $Candidate)
            } else {
                $Body = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
                Send-Response $Stream 404 "Not Found" $Body "text/plain; charset=utf-8"
            }
        }
        catch {
            Write-Warning $_.Exception.Message
        }
        finally {
            if ($Client) { $Client.Close() }
        }
    }
}
finally {
    if ($Listener) { $Listener.Stop() }
}
