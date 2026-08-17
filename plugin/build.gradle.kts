// External RuneLite plugin build. Follows the standard runelite/example-plugin
// shape: shaded JAR with runtimeOnly RuneLite deps (Hub / sideload path).
// For Path C (in-tree development) you don't need this at all — you just drop
// the source into runelite-client/src/main/java/... and run the RuneLite main
// class from IntelliJ. This file is here so you have a repro-able build once
// the plugin is stable enough to sideload via ~/.runelite/sideloaded-plugins/.
plugins {
    java
    id("com.github.johnrengelman.shadow") version "8.1.1"
}

group = "com.bigtimby"
version = "0.1.0"

repositories {
    mavenCentral()
    maven(url = "https://repo.runelite.net")
}

val runeLiteVersion = "1.10.30"  // TODO: bump to whatever RuneLite is on when you build

dependencies {
    compileOnly("net.runelite:client:$runeLiteVersion")
    compileOnly("net.runelite:runelite-api:$runeLiteVersion")

    compileOnly("org.projectlombok:lombok:1.18.30")
    annotationProcessor("org.projectlombok:lombok:1.18.30")

    compileOnly("com.google.inject:guice:5.1.0")
    compileOnly("com.google.guava:guava:32.1.3-jre")
    compileOnly("com.squareup.okhttp3:okhttp:4.12.0")
    compileOnly("com.google.code.gson:gson:2.10.1")
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(11))
    }
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release.set(11)
}
