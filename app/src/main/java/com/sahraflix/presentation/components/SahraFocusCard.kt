package com.sahraflix.presentation.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.combinedClickable
import androidx.compose.material3.Card as MobileCard
import androidx.compose.material3.CardDefaults as MobileCardDefaults
import com.sahraflix.presentation.LocalUiEnvironment
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Border
import androidx.tv.material3.Card
import androidx.tv.material3.CardDefaults
import com.sahraflix.presentation.theme.CinematicCharcoal
import com.sahraflix.presentation.theme.EmbersGlow
import com.sahraflix.presentation.theme.SahraGold
import androidx.tv.material3.Glow

/**
 * Focusable card. The TV Card is already a focus target with its own scale/border/glow
 * animations — the previous version added an extra `.focusable()` which created a second,
 * invisible focus stop per card and broke D-pad navigation.
 */
@Composable
fun SahraFocusCard(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    onLongClick: (() -> Unit)? = null,
    onFocusChanged: ((Boolean) -> Unit)? = null,
    content: @Composable BoxScope.() -> Unit
) {
    val shape = RoundedCornerShape(10.dp)
    if (!LocalUiEnvironment.current.isTv) {
        MobileCard(
            modifier = modifier.combinedClickable(onClick = onClick, onLongClick = onLongClick),
            shape = shape,
            colors = MobileCardDefaults.cardColors(containerColor = CinematicCharcoal)
        ) { Box(Modifier.fillMaxSize(), content = content) }
        return
    }
    Card(
        onClick = onClick,
        onLongClick = onLongClick,
        modifier = modifier.onFocusChanged { onFocusChanged?.invoke(it.isFocused) },
        shape = CardDefaults.shape(shape),
        scale = CardDefaults.scale(focusedScale = 1.07f),
        colors = CardDefaults.colors(containerColor = CinematicCharcoal),
        border = CardDefaults.border(focusedBorder = Border(BorderStroke(2.dp, SahraGold), shape = shape)),
        glow = CardDefaults.glow(focusedGlow = Glow(EmbersGlow.copy(alpha = 0.35f), 14.dp))
    ) { Box(Modifier.fillMaxSize()) { content() } }
}
