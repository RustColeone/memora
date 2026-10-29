# Project-specific R8/ProGuard rules.
#
# R8 is on for release builds (Play flags apps whose DEX is not optimized or
# obfuscated). These rules cover what Memora reaches by name or reflection.

# Keep line numbers so Play vitals stack traces stay readable after R8.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Capacitor reads @CapacitorPlugin(permissions = …) and @Permission(alias, strings)
# reflectively. In ImageDB, R8 full mode deleted the annotation members and
# replaced annotation.permissions() with null, so every permission check crashed
# the release build with a NullPointerException in Bridge.getPermissionStates.
# Memora's PlannerRemindersPlugin (notifications) uses the same annotations.
-keepattributes RuntimeVisibleAnnotations,AnnotationDefault
-keep @interface com.getcapacitor.annotation.** { *; }
-keep @interface com.getcapacitor.NativePlugin { *; }
-keep @interface com.getcapacitor.PluginMethod { *; }

# MainActivity exposes NativeShell.ready() to the packaged start page through an
# anonymous @JavascriptInterface object; the method is called by name from JS.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
