$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ProgressPreference = 'SilentlyContinue'
$startupError = $null
try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
    Add-Type -Path (Join-Path $PSScriptRoot 'selection.cs') -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase
} catch { $startupError = $_.Exception.Message }
while ($null -ne ($line = [Console]::ReadLine())) {
    $request = $null
    try {
        $request = ConvertFrom-Json $line
        if ($startupError) { throw $startupError }
        $result = [HuanyiSelection]::Read([long]$request.hwnd, [int]$request.x, [int]$request.y, [int]$request.ownProcess)
        $response = @{ id = $request.id; ok = $true; data = @{ text = $result.Text; blocked = $result.Blocked } }
    } catch {
        $response = @{ id = $request.id; ok = $false; error = $_.Exception.Message }
    }
    [Console]::WriteLine((ConvertTo-Json -InputObject $response -Compress -Depth 5))
}
