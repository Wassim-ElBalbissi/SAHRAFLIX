package com.sahraflix.data

import androidx.room.testing.MigrationTestHelper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sahraflix.data.local.IptvDatabase
import com.sahraflix.data.local.MIGRATION_7_8
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DatabaseMigrationTest {
    @get:Rule val helper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(), IptvDatabase::class.java
    )

    @Test fun upgradePreservesLibraryProfilesAndProgress() {
        val name = "migration-7-8"
        helper.createDatabase(name, 7).apply {
            execSQL("INSERT INTO playlists (id,name,url,username,type,lastUpdated) VALUES ('p','Portal','http://example.test','00:1A:79:00:00:01','STALKER',123)")
            execSQL("INSERT INTO categories (id,name,playlistId,streamType) VALUES ('c','News','p','LIVE')")
            execSQL("INSERT INTO stream_items (id,name,streamUrl,streamType,categoryId,playlistId,epgChannelId,providerId,catchupType,catchupSource) VALUES ('s','Channel','http://example.test/live','LIVE','c','p','guide-id','42','shift','http://example.test/archive')")
            execSQL("INSERT INTO favorites (streamId,createdAt) VALUES ('s',123)")
            execSQL("INSERT INTO watch_progress (contentId,title,streamUrl,positionMs,durationMs,updatedAt) VALUES ('movie','Movie','http://example.test/movie',60000,600000,123)")
            execSQL("INSERT INTO user_profiles (id,name,avatarKey,isKidsProfile,pinEnabled) VALUES (1,'Viewer','avatar_1',0,1)")
            close()
        }
        helper.runMigrationsAndValidate(name, 8, true, MIGRATION_7_8).apply {
            query("SELECT macAddress,username,syncState,itemCount FROM playlists WHERE id='p'").use {
                assertTrue(it.moveToFirst())
                assertEquals("00:1A:79:00:00:01", it.getString(0))
                assertTrue(it.isNull(1))
                assertEquals("NEVER", it.getString(2))
                assertEquals(0, it.getInt(3))
            }
            query("SELECT epgChannelId,providerId,catchupType,syncStamp FROM stream_items WHERE id='s'").use {
                assertTrue(it.moveToFirst())
                assertEquals("guide-id", it.getString(0))
                assertEquals("42", it.getString(1))
                assertEquals("shift", it.getString(2))
                assertEquals(0L, it.getLong(3))
            }
            query("SELECT positionMs FROM watch_progress WHERE contentId='movie'").use {
                assertTrue(it.moveToFirst()); assertEquals(60000L, it.getLong(0))
            }
            query("SELECT pinEnabled FROM user_profiles WHERE id=1").use {
                assertTrue(it.moveToFirst()); assertEquals(1, it.getInt(0))
            }
            query("SELECT streamId FROM favorites").use {
                assertTrue(it.moveToFirst()); assertEquals("s", it.getString(0))
            }
            // Replacing category data must not cascade-delete a stream after the upgrade.
            execSQL("DELETE FROM categories WHERE id='c'")
            query("SELECT id FROM stream_items WHERE id='s'").use { assertTrue(it.moveToFirst()) }
            query("PRAGMA foreign_key_check").use { assertFalse(it.moveToFirst()) }
            close()
        }
    }
}
