# Moshi reflective adapters (KotlinJsonAdapterFactory) need Kotlin metadata and DTO members.
-keep class kotlin.Metadata { *; }
-keepclassmembers class com.sahraflix.data.remote.** { <init>(...); <fields>; }
-keep class com.sahraflix.data.remote.Tmdb*Dto { *; }
# Retrofit
-keepattributes Signature, InnerClasses, EnclosingMethod, RuntimeVisibleAnnotations, RuntimeVisibleParameterAnnotations
-keepclassmembers,allowshrinking,allowobfuscation interface * { @retrofit2.http.* <methods>; }
-dontwarn javax.annotation.**
-dontwarn org.codehaus.mojo.animal_sniffer.*
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
# NanoHTTPD
-keep class fi.iki.elonen.** { *; }
# The source runtime's JS bridge is called by name from the bundled JavaScript.
-keepclassmembers class com.sahraflix.data.sources.** {
    @android.webkit.JavascriptInterface <methods>;
}
