using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Automation;

public sealed class HuanyiSelectionResult {
    public string Text { get; set; }
    public string Blocked { get; set; }
}

public static class HuanyiSelection {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    private static bool InWindow(AutomationElement element, IntPtr window) {
        // Browser accessibility nodes can be supplied by another process. Verify
        // ancestry to the actual foreground HWND, not equality with its process ID.
        for (int depth = 0; element != null && depth < 32; depth++) {
            if (unchecked((uint)element.Current.NativeWindowHandle) == unchecked((uint)window.ToInt64())) return true;
            element = TreeWalker.RawViewWalker.GetParent(element);
        }
        return false;
    }

    public static HuanyiSelectionResult Read(long handle, int x, int y, int ownProcess) {
        SetProcessDPIAware();
        var empty = new HuanyiSelectionResult();
        var window = new IntPtr(handle);
        if (GetForegroundWindow() != window) return empty;
        uint process;
        GetWindowThreadProcessId(window, out process);
        if (process == 0 || process == ownProcess) return empty;
        var focused = AutomationElement.FocusedElement;
        if (focused != null && InWindow(focused, window) && focused.Current.IsPassword)
            return new HuanyiSelectionResult { Blocked = "password" };
        var candidates = new List<AutomationElement>();
        var pointed = AutomationElement.FromPoint(new Point(x, y));
        if (pointed != null) candidates.Add(pointed);
        if (focused != null) candidates.Add(focused);
        foreach (var candidate in candidates) {
            if (!InWindow(candidate, window)) continue;
            var element = candidate;
            for (int depth = 0; element != null && depth < 32; depth++) {
                var current = element.Current;
                if (current.IsPassword) return new HuanyiSelectionResult { Blocked = "password" };
                object value;
                if (element.TryGetCurrentPattern(TextPattern.Pattern, out value)) {
                    var ranges = ((TextPattern)value).GetSelection();
                    var text = "";
                    foreach (var range in ranges) {
                        var part = range.GetText(24001);
                        if (!String.IsNullOrWhiteSpace(part)) text += (text.Length == 0 ? "" : "\n") + part;
                        if (text.Length > 24000) return new HuanyiSelectionResult { Blocked = "too-long" };
                    }
                    if (!String.IsNullOrWhiteSpace(text))
                        return GetForegroundWindow() == window ? new HuanyiSelectionResult { Text = text } : empty;
                }
                if (unchecked((uint)current.NativeWindowHandle) == unchecked((uint)window.ToInt64())) break;
                element = TreeWalker.RawViewWalker.GetParent(element);
            }
        }
        return empty;
    }
}
