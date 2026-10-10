package com.sahraflix.presentation.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.sahraflix.presentation.LocalUiEnvironment
import androidx.compose.material3.MaterialTheme as M3Theme
import androidx.compose.material3.darkColorScheme as m3Dark
import androidx.tv.material3.MaterialTheme as TvTheme
import androidx.tv.material3.Typography as TvTypography
import androidx.tv.material3.darkColorScheme as tvDark

private val TvColors = tvDark(
    primary          = NebulaCrimson,
    onPrimary        = TextPrimary,
    secondary        = AuroraViolet,
    background       = VoidBlack,
    onBackground     = TextPrimary,
    surface          = InkCard,
    onSurface        = TextPrimary,
    onSurfaceVariant = TextSecondary,
    scrim            = VoidBlack
)

private val M3Colors = m3Dark(
    primary                = NebulaCrimson,
    onPrimary              = TextPrimary,
    secondary              = AuroraViolet,
    background             = VoidBlack,
    onBackground           = TextPrimary,
    surface                = InkCard,
    onSurface              = TextPrimary,
    surfaceVariant         = AbyssBlue,
    onSurfaceVariant       = TextSecondary,
    surfaceContainer       = VoidBlack,
    secondaryContainer     = NebulaCrimson.copy(alpha = 0.12f),
    onSecondaryContainer   = NebulaCrimson,
    scrim                  = VoidBlack
)

private val Type = TvTypography(
    displaySmall  = TextStyle(color = TextPrimary,   fontSize = 36.sp, fontWeight = FontWeight.Bold),
    headlineLarge = TextStyle(color = TextPrimary,   fontSize = 32.sp, fontWeight = FontWeight.Bold),
    headlineSmall = TextStyle(color = TextPrimary,   fontSize = 22.sp, fontWeight = FontWeight.SemiBold),
    titleLarge    = TextStyle(color = TextPrimary,   fontSize = 22.sp, fontWeight = FontWeight.SemiBold),
    titleMedium   = TextStyle(color = TextPrimary,   fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
    titleSmall    = TextStyle(color = TextPrimary,   fontSize = 14.sp, fontWeight = FontWeight.Medium),
    bodyLarge     = TextStyle(color = TextSecondary, fontSize = 16.sp),
    bodyMedium    = TextStyle(color = TextSecondary, fontSize = 14.sp),
    bodySmall     = TextStyle(color = TextSecondary, fontSize = 12.sp),
    labelMedium   = TextStyle(color = TextMuted,     fontSize = 12.sp),
    labelLarge    = TextStyle(color = TextPrimary,   fontSize = 14.sp, fontWeight = FontWeight.Bold)
)

@Composable
fun SahraflixTheme(content: @Composable () -> Unit) {
    val env = LocalUiEnvironment.current
    M3Theme(colorScheme = M3Colors) {
        // Screens use a cinematic Box background rather than Surface, so supply its text colour.
        CompositionLocalProvider(
            androidx.compose.material3.LocalContentColor provides TextPrimary,
            androidx.tv.material3.LocalContentColor provides TextPrimary
        ) {
            if (env.isTv) {
                TvTheme(colorScheme = TvColors, typography = Type, content = content)
            } else {
                content()
            }
        }
    }
}
