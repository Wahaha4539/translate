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
        # UIA providers may disappear or reject a single read (for example E_FAIL).
        # PowerShell wraps CLR exceptions, so classify by type through the chain,
        # not by localized error messages. Startup and unexpected errors still fail.
        $providerUnavailable = $false
        if (-not $startupError) {
            $failure = $_.Exception
            while ($null -ne $failure) {
                if ($failure -is [System.Runtime.InteropServices.COMException] -or
                    $failure -is [System.Windows.Automation.ElementNotAvailableException]) {
                    $providerUnavailable = $true
                    break
                }
                $failure = $failure.InnerException
            }
        }
        if ($providerUnavailable) {
            # Keep the provisional button; copying remains gated on an explicit click.
            $response = @{ id = $request.id; ok = $true; data = @{ text = $null; blocked = $null } }
        } else {
            $response = @{ id = $request.id; ok = $false; error = $_.Exception.Message }
        }
    }
    [Console]::WriteLine((ConvertTo-Json -InputObject $response -Compress -Depth 5))
}
