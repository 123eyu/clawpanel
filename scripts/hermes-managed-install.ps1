param(
    [string]$InstallerPath, [string]$HermesHome, [string]$InstallDir,
    [string]$Branch, [string]$Commit, [switch]$ForceCommit,
    [switch]$SkipSetup, [switch]$SkipComputerUse, [switch]$NonInteractive,
    [switch]$Json, [string]$Stage
)
$ErrorActionPreference = 'Stop'

function Assert-ClawPanelLegacyStage([string]$Name) {
    if ($Name -cnotin @('uv','git','node','repository','python','venv','dependencies','node-deps','config-templates','platform-sdks','bootstrap-marker')) {
        throw 'ClawPanel legacy installer: unknown or unmanaged stage'
    }
}

function Read-ClawPanelLegacyInstaller([string]$SourcePath) {
    # 原版字节只读；不接受用户提供另一 hash，不修改 vendor 文件。
    $item = Get-Item -LiteralPath $SourcePath -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'ClawPanel legacy installer: non-regular source' }
    $bytes = [IO.File]::ReadAllBytes($item.FullName)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() } finally { $hasher.Dispose() }
    if ($hash -cne '0a80dfeb7434229933bac32e73140d10086dff81bd84b156e71be9abc87cddf2') { throw 'ClawPanel legacy installer: pinned vendor SHA256 mismatch' }
    return [Text.Encoding]::UTF8.GetString($bytes)
}

function Get-ClawPanelLegacyDefinitions([string]$Source) {
    # 只适配固定旧版的三函数五节点；不按字符串搜索替换整个安装器。
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($Source, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'ClawPanel legacy installer: AST parse failure' }
    $specs = [ordered]@{
        'Set-ManagedNodeFirstOnUserPath' = @(@('GetEnvironmentVariable','Path',2), @('SetEnvironmentVariable','Path',3))
        'Install-Git' = @(@('GetEnvironmentVariable','Path',2), @('SetEnvironmentVariable','Path',3))
        'Set-GitBashEnvVar' = @(,@('SetEnvironmentVariable','HERMES_GIT_BASH_PATH',3))
    }
    $definitions = @(); $total = 0
    foreach ($name in $specs.Keys) {
        $functions = @($ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $true) | Where-Object { $_.Name -ceq $name })
        if ($functions.Count -ne 1) { throw "ClawPanel legacy installer: function count $name" }
        $fn = $functions[0]
        if ($fn.IsFilter -or $fn.IsWorkflow -or $fn.Parameters.Count) { throw "ClawPanel legacy installer: signature $name" }
        $parameters = @($fn.Body.ParamBlock.Parameters)
        if ($name -ceq 'Set-ManagedNodeFirstOnUserPath') {
            if ($parameters.Count -ne 1 -or $parameters[0].Name.VariablePath.UserPath -cne 'NodeDir' -or
                $parameters[0].DefaultValue -or $parameters[0].Attributes.Count -ne 1 -or
                $parameters[0].Attributes[0] -isnot [System.Management.Automation.Language.TypeConstraintAst] -or
                $parameters[0].Attributes[0].TypeName.FullName -cne 'string') { throw "ClawPanel legacy installer: signature $name" }
        } elseif ($fn.Body.ParamBlock) { throw "ClawPanel legacy installer: signature $name" }
        $calls = @($fn.Body.FindAll({param($n)
            $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
            $n.Member.Value -in @('GetEnvironmentVariable','SetEnvironmentVariable') -and $n.Arguments.Count -ge 2
        }, $true))
        $expected = $specs[$name]
        if ($calls.Count -ne $expected.Count) { throw "ClawPanel legacy installer: call count $name" }
        $edits = @()
        for ($i = 0; $i -lt $calls.Count; $i++) {
            $call = $calls[$i]; $spec = $expected[$i]
            if (-not $call.Static -or $call.Expression -isnot [System.Management.Automation.Language.TypeExpressionAst] -or
                $call.Expression.TypeName.FullName -cne 'Environment' -or $call.Member.Value -cne $spec[0] -or
                $call.Arguments.Count -ne $spec[2] -or
                $call.Arguments[0] -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or
                $call.Arguments[0].Value -cne $spec[1]) { throw "ClawPanel legacy installer: call shape $name" }
            $target = $call.Arguments[$call.Arguments.Count - 1]
            if ($target -isnot [System.Management.Automation.Language.StringConstantExpressionAst] -or $target.Value -cne 'User') { throw "ClawPanel legacy installer: target $name" }
            if ($call.Member.Value -ceq 'SetEnvironmentVariable') {
                $value = @{ 'Set-ManagedNodeFirstOnUserPath'='$updated'; 'Install-Git'='($userPathItems -join ";")'; 'Set-GitBashEnvVar'='$candidate' }[$name]
                if ($call.Arguments[1].Extent.Text -cne $value) { throw "ClawPanel legacy installer: value shape $name" }
            }
            $edits += @{ Start=($target.Extent.StartOffset - $fn.Extent.StartOffset); Length=($target.Extent.EndOffset - $target.Extent.StartOffset) }
        }
        $definition = $fn.Extent.Text
        foreach ($edit in ($edits | Sort-Object Start -Descending)) {
            $definition = $definition.Substring(0,$edit.Start) + "'Process'" + $definition.Substring($edit.Start + $edit.Length)
        }
        $definitions += $definition; $total += $edits.Count
    }
    if ($total -ne 5) { throw 'ClawPanel legacy installer: expected exactly five redirections' }
    return @{ Definitions=$definitions; Redirections=$total }
}

function Initialize-ClawPanelLegacyEnvironment([string]$HomePath, [string]$BasePath) {
    $script:ClawPanelManagedHome = [IO.Path]::GetFullPath($HomePath)
    $script:ClawPanelManagedBasePath = $BasePath
    $env:UV_NO_MODIFY_PATH = '1'
    $script:ClawPanelWingetAttempted = $false
}

function Sync-ClawPanelLegacyPath {
    # 每个 stage 都从受管目录及父进程传入 PATH 重建，不依赖 User/Machine 写入。
    $entries = @()
    foreach ($relative in @('bin','git\cmd','git\bin','git\usr\bin','node')) {
        $candidate = Join-Path $script:ClawPanelManagedHome $relative
        if (Test-Path -LiteralPath $candidate -PathType Container) { $entries += $candidate }
    }
    $entries += @($script:ClawPanelManagedBasePath -split ';')
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $ordered = @($entries | Where-Object { $_ -and $seen.Add($_) })
    $env:Path = $ordered -join ';'
}

function winget {
    # 在命令函数入口拦截，绝不调用系统 winget；上游 catch 也不能消除触发标记。
    $script:ClawPanelWingetAttempted = $true
    [Console]::Error.WriteLine('CLAWPANEL_MANAGED_INSTALL winget-blocked')
    throw 'ClawPanel managed install forbids system winget fallback'
}

function Invoke-ClawPanelManagedStage([scriptblock]$Action) {
    $frames = New-Object 'System.Collections.Generic.List[object]'
    $started = [DateTime]::UtcNow
    $failure = $null
    try { & $Action | ForEach-Object { $frames.Add($_) } } catch { $failure = $_ }
    if ($script:ClawPanelWingetAttempted) {
        # 原 worker 可能 catch 后声称 ok；保留日志但将其 stage frame 变为明确失败。
        $emitted = $false
        foreach ($frame in $frames) {
            try { $parsed = $frame | ConvertFrom-Json -ErrorAction Stop } catch { Write-Output $frame; continue }
            if ($parsed.PSObject.Properties.Name -contains 'stage' -and $parsed.PSObject.Properties.Name -contains 'ok') {
                $parsed.ok = $false; $parsed.skipped = $false
                $parsed.reason = 'ClawPanel managed install blocked system winget fallback'
                $parsed | ConvertTo-Json -Compress | Write-Output
                $emitted = $true
            } else { Write-Output $frame }
        }
        if (-not $emitted) {
            @{stage=$Stage;ok=$false;skipped=$false;reason='ClawPanel managed install blocked system winget fallback';duration_ms=[int]([DateTime]::UtcNow - $started).TotalMilliseconds} | ConvertTo-Json -Compress | Write-Output
        }
        throw 'ClawPanel managed install blocked system winget fallback after Invoke-Stage'
    }
    $frames | Write-Output
    if ($null -ne $failure) { throw $failure }
}

function Invoke-ClawPanelLegacyInstaller {
    Assert-ClawPanelLegacyStage $Stage
    if ($Branch -cne 'v2026.9.24' -or $Commit -cne 'f97608f178d1ffeca59860195ab7da295f7c8e5f' -or
        -not ($ForceCommit -and $SkipSetup -and $SkipComputerUse -and $NonInteractive -and $Json)) { throw 'ClawPanel legacy installer: fixed pin/flags required' }
    $homePath = [IO.Path]::GetFullPath($HermesHome).TrimEnd('\') + '\'
    foreach ($p in @($InstallerPath,$InstallDir)) {
        if (-not [IO.Path]::GetFullPath($p).StartsWith($homePath,[StringComparison]::OrdinalIgnoreCase)) { throw 'ClawPanel legacy installer: path outside managed home' }
    }
    $source = Read-ClawPanelLegacyInstaller $InstallerPath
    $adapted = Get-ClawPanelLegacyDefinitions $source
    Initialize-ClawPanelLegacyEnvironment $HermesHome $env:Path
    $vendorArgs = @{HermesHome=$HermesHome;InstallDir=$InstallDir;Branch=$Branch;Commit=$Commit;ForceCommit=$true;SkipSetup=$true;SkipComputerUse=$true;NonInteractive=$true;Json=$true;Stage=$Stage}
    . $InstallerPath @vendorArgs
    foreach ($definition in $adapted.Definitions) { . ([ScriptBlock]::Create($definition)) }
    function Sync-EnvPath { Sync-ClawPanelLegacyPath }
    [Console]::Error.WriteLine("CLAWPANEL_MANAGED_INSTALL stage=$Stage redirections=5 vendor-sha256=0a80dfeb7434229933bac32e73140d10086dff81bd84b156e71be9abc87cddf2")
    $def = Get-InstallStage -Name $Stage
    if (-not $def) { throw 'ClawPanel legacy installer: missing official stage' }
    Step-OutOfInstallDir
    Invoke-ClawPanelManagedStage { Invoke-Stage -StageDef $def }
    # 即使未来 stage 层吞错，标记仍须导致进程失败。
    if ($script:ClawPanelWingetAttempted) { throw 'ClawPanel managed install forbidden fallback' }
}

# 供隔离解析/sink 测试加载函数；执行入口始终执行固定原版 hash 门禁。
if ($MyInvocation.InvocationName -eq '.') { return }
$script:ClawPanelWingetAttempted = $false
try {
    Assert-ClawPanelLegacyStage $Stage
} catch {
    @{stage=$Stage;ok=$false;reason='unknown or unmanaged stage'} | ConvertTo-Json -Compress | Write-Output
    exit 2
}
try {
    Invoke-ClawPanelLegacyInstaller
    exit 0
} catch {
    if (-not $script:_StageEmittedErrorFrame -and -not $script:ClawPanelWingetAttempted) {
        @{stage=$Stage;ok=$false;reason="$_"} | ConvertTo-Json -Compress | Write-Output
    }
    [Console]::Error.WriteLine("CLAWPANEL_MANAGED_INSTALL failed: $_")
    exit 1
}
