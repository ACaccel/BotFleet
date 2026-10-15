# 地牛Wake Up! 強震警報轉發（Windows）

地牛Wake Up! 收到符合門檻的強震即時警報時，會執行 `earthquake-alert.cmd`。腳本把警報透過
Tailscale 以 HTTPS 送到 nijika，nijika 再發到各伺服器的 `earthquake` 頻道。

```text
地牛Wake Up! → earthquake-alert.cmd → earthquake-alert.ps1
  → https://<server>.<tailnet>.ts.net/earthquake/alerts（只限 tailnet）
  → tailscale serve → nijika POST /alerts（127.0.0.1）
```

伺服器端規則（詳見[設定文件](../../../docs/configuration.md#earthquake-alerts-and-reports)）：

- 每則即時警報都會發文；本地震度達到伺服器設定的門檻（預設 4 級）才標記伺服器的 `earthquake` 身分組。
- 同一個地震的更新警報會編輯原本的訊息；更新後第一次達到門檻時，另外回覆一則標記身分組的訊息。
- 抵達時間早於 10 分鐘前的請求視為測試，只回報連線成功，不會發到 Discord。

## 需求

- Windows 10 或 11，內建的 Windows PowerShell 5.1。
- 這台電腦的 Tailscale 已登入同一個 tailnet 並保持連線。
- 伺服器管理者提供的兩項資訊：
  - 警報網址，格式為 `https://<server>.<tailnet>.ts.net/earthquake/alerts`。管理者在伺服器執行
    `tailscale serve status`，就能看到 `/earthquake/` 對應的完整網址。
  - 金鑰（伺服器上的 `EARTHQUAKE_ALERT_KEY`）。

## 安裝

1. 把 `earthquake-alert.cmd` 和 `earthquake-alert.ps1` 放進同一個固定的資料夾，例如
   `%LOCALAPPDATA%\BotFleet\earthquake-alert\`。路徑有中文沒關係。不要另存或轉換
   `.ps1` 的編碼，它必須維持 UTF-8 with BOM。
2. 如果檔案是從網路下載的，在 PowerShell 解除封鎖：

   ```powershell
   Get-ChildItem "$env:LOCALAPPDATA\BotFleet\earthquake-alert" | Unblock-File
   ```

3. 在腳本旁邊建立 `earthquake-alert.config.json`（必要），填入管理者提供的警報網址。網址必須是
   `https://`；沒有這個檔案時，腳本會以結束代碼 1 結束（`setup-error`）。

   ```json
   { "url": "https://<server>.<tailnet>.ts.net/earthquake/alerts" }
   ```

4. 建立金鑰檔，並設定成只有目前的使用者能存取。在一般（非系統管理員）PowerShell 執行，
   出現提示時貼上金鑰：

   ```powershell
   $dir = Join-Path $env:LOCALAPPDATA 'BotFleet'
   New-Item -ItemType Directory -Force -Path $dir | Out-Null
   $keyFile = Join-Path $dir 'earthquake-alert.key'
   $secure = Read-Host -AsSecureString 'Paste the key'
   $plain = [Net.NetworkCredential]::new('', $secure).Password
   Set-Content -LiteralPath $keyFile -Value $plain -Encoding ASCII -NoNewline
   Remove-Variable plain, secure
   $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
   icacls $keyFile /inheritance:r /grant:r "*${sid}:F"
   icacls $keyFile
   ```

   最後一行的輸出應該只列出你自己的帳號。以 SID 授權，可以避開中文使用者名稱的編碼問題。

## 地牛Wake Up! 設定

1. 勾選「收到警報且符合預警震度後執行程式」。
2. 程式選擇 `earthquake-alert.cmd`（不是 `.ps1`）。
3. 建議取消勾選「僅執行一次」。中央氣象署會針對同一個地震發布更新警報，每次更新都會執行
   腳本，Discord 上的訊息才會跟著更新。
4. 用 App 的預警震度門檻決定哪些警報要送出。伺服器不會再過濾，收到的每則都會發文，但只有
   本地震度達到伺服器的標記門檻才會標記身分組。這個門檻由伺服器管理者在 nijika 的
   `config.json` 設定（`earthquake_alert.ping_min_local_intensity`，預設 4 級）。例如 App 門檻設
   3 級、伺服器維持預設時，3 級警報會發文但不標記。

## 測試

在 App 按「測試」。App 會用下面這組固定的範例參數執行程式（抵達時間在 2024 年）：

```text
--epicenter-lat=23.85 --epicenter-lon=120.82 --depth=10 --magnitude=7.3 --max-intensity=7 --local-intensity=5+ --arrival-time=1717142400 --remaining-time=20
```

伺服器把它當成測試，不會發文。成功時會跳出「連線測試成功」，失敗時會跳出錯誤說明。只有測試
會跳出視窗；真正的警報不會，以免擋住後續的警報。

也可以在 PowerShell 手動執行同一組參數，再查看結束代碼：

```powershell
& "$env:LOCALAPPDATA\BotFleet\earthquake-alert\earthquake-alert.cmd" --epicenter-lat=23.85 --epicenter-lon=120.82 --depth=10 --magnitude=7.3 --max-intensity=7 --local-intensity=5+ --arrival-time=1717142400 --remaining-time=20
$LASTEXITCODE
```

## 紀錄與結束代碼

每次執行會在 `%LOCALAPPDATA%\BotFleet\earthquake-alert.log` 追加一行，例如
`result=created pinged=True guilds=2 status=200 attempts=1 local=5+ ...`。紀錄不會包含金鑰。

| 結束代碼 | 意義                                                         |
| -------- | ------------------------------------------------------------ |
| `0`      | 已發文（`created`）、已更新（`updated`）或測試成功（`test`） |
| `1`      | 參數錯誤，或設定檔、金鑰檔有問題（`setup-error`）            |
| `2`      | 請求失敗（`failed`），紀錄中有 HTTP 狀態碼與原因             |

連線失敗或伺服器回應 5xx 時，腳本會立刻重試一次；每次請求最多等 5 秒。

## 疑難排解

| 症狀                               | 處理方式                                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status=401`、「金鑰不符」         | 金鑰檔內容和伺服器不同。向管理者確認金鑰後，重做安裝步驟 4。                                                                                                                                                                         |
| `status=0`、逾時、「連不到伺服器」 | 確認 Tailscale 已連線（`tailscale status`）。用瀏覽器開設定檔裡的網址，看到 `{"error":"unauthorized"}` 代表網路通、nijika 正常。                                                                                                     |
| `status=404` 或其他非預期的狀態碼  | 確認設定檔的網址結尾是 `/earthquake/alerts`；若正確，伺服器的 `tailscale serve` 路徑或 nijika 的警報設定可能沒開，請聯絡管理者。                                                                                                     |
| `status=503`                       | nijika 剛啟動，Discord 尚未就緒，稍後再測試。                                                                                                                                                                                        |
| `setup-error`                      | 紀錄會寫出原因：`config file ...` 表示腳本旁的 `earthquake-alert.config.json` 不存在、格式錯誤或網址不是 `https://`（安裝步驟 3）；`key file ...` 表示 `%LOCALAPPDATA%\BotFleet\earthquake-alert.key` 不存在或是空的（安裝步驟 4）。 |
| 手動執行時出現「已停用指令碼執行」 | `.cmd` 已用 `-ExecutionPolicy Bypass` 執行；若仍被擋，可能是群組原則強制。用 `Get-ExecutionPolicy -List` 查看，並確認已做安裝步驟 2。                                                                                                |
| 完全沒有紀錄                       | App 沒有執行程式。確認 App 的勾選與程式路徑，並用上面的手動指令測試。                                                                                                                                                                |
