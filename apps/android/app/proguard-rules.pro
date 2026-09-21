# Keep kotlinx.serialization generated serializers.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class app.daftar.data.** {
    <init>(...);
    <fields>;
}
-keepclasseswithmembers class app.daftar.data.** {
    static kotlinx.serialization.KSerializer serializer();
}
# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
