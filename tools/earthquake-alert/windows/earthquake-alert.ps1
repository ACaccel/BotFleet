# Forwards one 地牛Wake Up! early-warning alert to nijika's earthquake alert API.
#
# The warning app runs earthquake-alert.cmd, which starts this script with the
# app's --name=value arguments. Windows PowerShell 5.1 compatible. This file
# contains non-ASCII text and must stay saved as UTF-8 with BOM.
#
# Exit codes: 0 delivered or test acknowledged; 1 invalid arguments or local
# setup (key file, config file); 2 the request failed.

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
# The progress bar slows Invoke-WebRequest down noticeably in PowerShell 5.1.
$ProgressPreference = 'SilentlyContinue'

$ScriptArguments = @($args)

$TimeoutSeconds = 5
# Matches the server: the app's fixed test-button values, or an arrival time
# this far in the past, mark a test.
$TestAgeSeconds = 600
$AppTestAlert = @{
    epicenterLat = 23.85; epicenterLon = 120.82; depthKm = 10; magnitude = 7.3
    maxIntensity = '7'; localIntensity = '5+'; remainingSeconds = 20
}
$DataDir = Join-Path $env:LOCALAPPDATA 'Pleiades'
$KeyFile = Join-Path $DataDir 'earthquake-alert.key'
$LogFile = Join-Path $DataDir 'earthquake-alert.log'
# Required: { "url": "https://<server>.<tailnet>.ts.net/earthquake/alerts" }
$ConfigFile = Join-Path $PSScriptRoot 'earthquake-alert.config.json'
$NoticeTitle = '地牛Wake Up! → Pleiades'

# App argument -> request field and value kind. The repository's contract
# test reads this table, so keep one entry per line in this exact shape.
$ArgumentMap = [ordered]@{
    'epicenter-lat'   = @{ Field = 'epicenterLat'; Kind = 'Number' }
    'epicenter-lon'   = @{ Field = 'epicenterLon'; Kind = 'Number' }
    'depth'           = @{ Field = 'depthKm'; Kind = 'Number' }
    'magnitude'       = @{ Field = 'magnitude'; Kind = 'Number' }
    'max-intensity'   = @{ Field = 'maxIntensity'; Kind = 'Intensity' }
    'local-intensity' = @{ Field = 'localIntensity'; Kind = 'Intensity' }
    'arrival-time'    = @{ Field = 'arrivalTime'; Kind = 'Integer' }
    'remaining-time'  = @{ Field = 'remainingSeconds'; Kind = 'Integer' }
}
$Intensities = @('0', '1', '2', '3', '4', '5-', '5+', '6-', '6+', '7')

function Write-AlertLog([string]$Line) {
    try {
        if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) {
            New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
        }
        $stamp = [DateTimeOffset]::Now.ToString('yyyy-MM-dd HH:mm:ss zzz')
        Add-Content -LiteralPath $LogFile -Value "$stamp $Line" -Encoding UTF8
    } catch {
        # A log failure must never turn a delivered alert into a failure.
    }
}

function Show-Notice([string]$Text, [bool]$IsError) {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        # A topmost owner keeps the box in front of the warning app.
        $owner = New-Object System.Windows.Forms.Form
        $owner.TopMost = $true
        $icon = [System.Windows.Forms.MessageBoxIcon]::Information
        if ($IsError) { $icon = [System.Windows.Forms.MessageBoxIcon]::Error }
        [void][System.Windows.Forms.MessageBox]::Show(
            $owner, $Text, $NoticeTitle, [System.Windows.Forms.MessageBoxButtons]::OK, $icon)
        $owner.Dispose()
    } catch {
        Write-AlertLog "notice-failed error=""$($_.Exception.Message)"""
    }
}

function ConvertFrom-AlertArguments([object[]]$Arguments) {
    $values = @{}
    foreach ($raw in $Arguments) {
        $text = [string]$raw
        $match = [regex]::Match($text, '^--([a-z-]+)=(.*)$')
        if (-not $match.Success) { throw "unexpected argument '$text'" }
        $name = $match.Groups[1].Value
        if (-not $ArgumentMap.Contains($name)) { throw "unknown argument --$name" }
        if ($values.ContainsKey($name)) { throw "duplicate argument --$name" }
        $values[$name] = $match.Groups[2].Value
    }
    $body = [ordered]@{}
    foreach ($name in $ArgumentMap.Keys) {
        if (-not $values.ContainsKey($name)) { throw "missing argument --$name" }
        $spec = $ArgumentMap[$name]
        $value = $values[$name]
        if ($spec.Kind -eq 'Intensity') {
            if ($Intensities -cnotcontains $value) { throw "invalid --${name} '$value'" }
            $body[$spec.Field] = $value
            continue
        }
        $number = 0.0
        $parsed = [double]::TryParse(
            $value,
            [Globalization.NumberStyles]::Float,
            [Globalization.CultureInfo]::InvariantCulture,
            [ref]$number)
        if (-not $parsed -or [double]::IsNaN($number) -or [double]::IsInfinity($number)) {
            throw "invalid --${name} '$value'"
        }
        if ($spec.Kind -eq 'Integer') {
            $body[$spec.Field] = [long][Math]::Round($number)
        } else {
            $body[$spec.Field] = $number
        }
    }
    return $body
}

function Get-AlertUrl {
    if (-not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) {
        throw "config file not found: $ConfigFile"
    }
    try {
        $config = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "config file is not valid JSON: $ConfigFile"
    }
    $property = $null
    if ($null -ne $config) { $property = $config.PSObject.Properties['url'] }
    if ($null -eq $property) { throw "config file has no url: $ConfigFile" }
    $uri = $null
    if (-not [Uri]::TryCreate([string]$property.Value, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https') {
        throw "url in $ConfigFile must be an absolute https URL"
    }
    return $uri.AbsoluteUri
}

function Read-AlertKey {
    if (-not (Test-Path -LiteralPath $KeyFile -PathType Leaf)) {
        throw "key file not found: $KeyFile"
    }
    $key = ([string](Get-Content -LiteralPath $KeyFile -Raw)).Trim()
    if ($key.Length -eq 0) { throw "key file is empty: $KeyFile" }
    return $key
}

# Returns the HTTP status (0 when no response arrived), the response body and
# the transport error, if any. Never includes request headers.
function Send-Alert([string]$Url, [string]$Key, [byte[]]$Body) {
    try {
        $response = Invoke-WebRequest -Uri $Url -Method Post -UseBasicParsing `
            -Headers @{ Authorization = "Bearer $Key" } `
            -ContentType 'application/json; charset=utf-8' -Body $Body `
            -TimeoutSec $TimeoutSeconds
        return @{ Status = [int]$response.StatusCode; Content = [string]$response.Content; Error = '' }
    } catch [System.Net.WebException] {
        $webResponse = $_.Exception.Response
        if ($null -eq $webResponse) {
            return @{ Status = 0; Content = ''; Error = $_.Exception.Message }
        }
        $content = ''
        try {
            $reader = New-Object System.IO.StreamReader($webResponse.GetResponseStream())
            $content = $reader.ReadToEnd()
            $reader.Dispose()
        } catch {
            $content = ''
        }
        return @{ Status = [int]$webResponse.StatusCode; Content = $content; Error = $_.Exception.Message }
    }
}

function Get-FailureHint([int]$Status) {
    if ($Status -eq 0) { return '連不到伺服器。請確認這台電腦的 Tailscale 已連線，且伺服器正在執行。' }
    if ($Status -eq 401) { return '金鑰不符。請確認金鑰檔與伺服器的 EARTHQUAKE_ALERT_KEY 相同。' }
    if ($Status -eq 503) { return '伺服器的 Discord 連線尚未就緒，請稍後再試。' }
    return "伺服器回應 HTTP $Status。"
}

function Invoke-Main {
    try {
        $body = ConvertFrom-AlertArguments $ScriptArguments
    } catch {
        Write-AlertLog "result=invalid-arguments error=""$($_.Exception.Message)"""
        return 1
    }
    $summary = "local=$($body.localIntensity) max=$($body.maxIntensity) magnitude=$($body.magnitude) arrival=$($body.arrivalTime) remaining=$($body.remainingSeconds)"
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $isAppTest = $true
    foreach ($field in $AppTestAlert.Keys) {
        if ($body[$field] -ne $AppTestAlert[$field]) { $isAppTest = $false }
    }
    $isTest = $isAppTest -or ($body.arrivalTime -lt ($now - $TestAgeSeconds))

    try {
        $url = Get-AlertUrl
        $key = Read-AlertKey
    } catch {
        $message = $_.Exception.Message
        Write-AlertLog "result=setup-error $summary error=""$message"""
        if ($isTest) { Show-Notice "連線測試失敗：$message" $true }
        return 1
    }

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        # TLS 1.3 exists only on newer .NET builds; add it where available.
        if ([Enum]::GetNames([Net.SecurityProtocolType]) -contains 'Tls13') {
            [Net.ServicePointManager]::SecurityProtocol =
                [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls13
        }
        $payload = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $body -Compress))

        # One immediate retry when no response arrived or the server failed;
        # the server folds a repeated alert into the same Discord message.
        $attempts = 0
        do {
            $attempts++
            $result = Send-Alert $url $key $payload
            $retry = ($result.Status -eq 0 -or $result.Status -ge 500) -and $attempts -lt 2
        } while ($retry)
    } catch {
        $result = @{ Status = 0; Content = ''; Error = $_.Exception.Message }
        $attempts = 1
    }

    if ($result.Status -eq 200) {
        $outcome = 'unknown'
        $details = ''
        try {
            $reply = ConvertFrom-Json $result.Content
            $outcome = [string]$reply.result
            if ($outcome -ne 'test') { $details = " pinged=$($reply.pinged) guilds=$($reply.guilds)" }
        } catch {
            $outcome = 'unreadable-response'
        }
        Write-AlertLog "result=$outcome$details status=200 attempts=$attempts $summary"
        if ($outcome -eq 'test') {
            Show-Notice '連線測試成功：Pleiades 已收到測試警報（測試不會發到 Discord）。' $false
        }
        return 0
    }

    $reason = $result.Error
    if ($result.Content.Length -gt 0) { $reason = $result.Content }
    if ($reason.Length -gt 300) { $reason = $reason.Substring(0, 300) }
    $reason = $reason -replace '[\r\n"]+', ' '
    Write-AlertLog "result=failed status=$($result.Status) attempts=$attempts $summary error=""$reason"""
    if ($isTest) {
        Show-Notice "連線測試失敗：$(Get-FailureHint $result.Status)`n`n詳細紀錄：$LogFile" $true
    }
    return 2
}

exit (Invoke-Main)
