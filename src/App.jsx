import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';

// Constants for Rainfall Intensity Coefficients (from LA DOTD Hydraulics Manual, Figures 3.4-3, 3.4-4, 3.4-5)
const RAINFALL_COEFFICIENTS = {
  'Region 1': {
    '2-Year': { a: 2.815, b: 0.282, c: -0.899 },
    '5-Year': { a: 3.536, b: 0.330, c: -0.851 },
    '10-Year': { a: 4.016, b: 0.347, c: -0.826 },
    '25-Year': { a: 4.611, b: 0.346, c: -0.798 },
    '50-Year': { a: 5.097, b: 0.351, c: -0.783 },
    '100-Year': { a: 5.487, b: 0.334, c: -0.759 },
  },
  'Region 2': {
    '2-Year': { a: 2.375, b: 0.221, c: -0.922 },
    '5-Year': { a: 2.976, b: 0.251, c: -0.865 },
    '10-Year': { a: 3.447, b: 0.277, c: -0.839 },
    '25-Year': { a: 4.092, b: 0.297, c: -0.808 },
    '50-Year': { a: 4.640, b: 0.318, c: -0.791 },
    '100-Year': { a: 5.195, b: 0.335, c: -0.771 },
  },
  'Region 3': {
    '2-Year': { a: 2.138, b: 0.192, c: -0.891 },
    '5-Year': { a: 2.701, b: 0.220, c: -0.847 },
    '10-Year': { a: 3.086, b: 0.231, c: -0.826 },
    '25-Year': { a: 3.592, b: 0.238, c: -0.809 },
    '50-Year': { a: 3.934, b: 0.227, c: -0.794 },
    '100-Year': { a: 4.286, b: 0.223, c: -0.780 },
  },
};

// Helper function to format numbers to a fixed decimal place
const formatNumber = (num, fixed = 2) => {
  if (typeof num !== 'number' || isNaN(num)) return '';
  return num.toFixed(fixed);
};

// Calculations Utility Functions
const calculateTC = (HL, C, S) => {
  // TC = 0.7039 * (HL^0.3917) * (C^-1.1309) * (S^-0.1985)
  // TC in minutes, HL in feet, C (dimensionless), S in percent.
  if (HL <= 0 || C <= 0 || S <= 0) return 0;
  const tc = 0.7039 * Math.pow(HL, 0.3917) * Math.pow(C, -1.1309) * Math.pow(S, -0.1985);
  return Math.max(tc, 5); // TC should not be less than 5 minutes
};

const calculateIntensity = (tcMinutes, region, returnPeriod) => {
  const coeffs = RAINFALL_COEFFICIENTS[region]?.[returnPeriod];
  if (!coeffs || tcMinutes <= 0) return 0;
  const D = tcMinutes / 60; // Duration in hours
  const I = coeffs.a * Math.pow(D + coeffs.b, coeffs.c);
  return I;
};

const calculateQ = (intensity, sumAC) => {
  // Q = I * ∑AC, where ∑AC is sum of (Area * C)
  if (intensity <= 0 || sumAC <= 0) return 0;
  return intensity * sumAC;
};

const calculateWidthOfFlooding = (qTotal, longitudinalSlopePercent, crossSlope, n = 0.015) => {
  // Equation 8-A.7-1: Q = 0.56/n * Sx^(5/3) * T^(8/3) * S^(1/2)
  // Solve for T (Width of Flooding)
  // T = (Q * n / (0.56 * Sx^(5/3) * S^(1/2)))^(3/8)
  if (qTotal <= 0 || longitudinalSlopePercent <= 0 || crossSlope <= 0 || n <= 0) return 0;
  const S_longitudinal = longitudinalSlopePercent / 100; // Convert percent to ft/ft
  const numerator = qTotal * n;
  const denominator = 0.56 * Math.pow(crossSlope, 5 / 3) * Math.pow(S_longitudinal, 1 / 2);
  if (denominator === 0) return 0; // Avoid division by zero
  const T = Math.pow(numerator / denominator, 3 / 8);
  return T;
};


// Custom Modal Component for messages
const Modal = ({ message, onClose }) => {
  if (!message) return null;
  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl p-6 max-w-sm w-full">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Notification</h3>
        <p className="text-gray-700 mb-6 whitespace-pre-wrap">{message}</p>
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

// Profile Definition Component
const ProfileDefinition = ({ profile, setProfile, addPVI, removePVI, displayMessage }) => {
  const canvasRef = useRef(null);

  const drawProfile = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const profilePointsForDrawing = [];
    const plotStep = 5;

    const getTangentElevation = (startStation, startElevation, gradePercent, targetStation) => {
        if (isNaN(startStation) || isNaN(startElevation) || isNaN(gradePercent) || isNaN(targetStation)) return NaN;
        return startElevation + (gradePercent / 100) * (targetStation - startStation);
    };

    const pviDetails = profile.pvis.map((pvi, i) => {
        const L_curve = parseFloat(pvi.length) || 0;
        const PVI_station = parseFloat(pvi.station) || 0;
        const PVI_elevation = parseFloat(pvi.elevation) || 0;

        let g_in_percent;
        if (i === 0) {
            g_in_percent = parseFloat(profile.beginningGrade);
            if(isNaN(g_in_percent)) g_in_percent = 0;
        } else {
            const prevPVI = profile.pvis[i - 1];
            const prevPVI_station = parseFloat(prevPVI.station) || 0;
            const prevPVI_elevation = parseFloat(prevPVI.elevation) || 0;
            if (PVI_station === prevPVI_station) {
                g_in_percent = 0;
            } else {
                g_in_percent = (PVI_elevation - prevPVI_elevation) / (PVI_station - prevPVI_station) * 100;
            }
        }
        if (isNaN(g_in_percent)) g_in_percent = 0;

        let g_out_percent;
        if (i === profile.pvis.length - 1) {
            g_out_percent = parseFloat(profile.endingGrade);
            if(isNaN(g_out_percent)) g_out_percent = 0;
        } else {
            const nextPVI = profile.pvis[i + 1];
            const nextPVI_station = parseFloat(nextPVI.station) || 0;
            const nextPVI_elevation = parseFloat(nextPVI.elevation) || 0;
            if (nextPVI_station === PVI_station) {
                g_out_percent = 0;
            } else {
                g_out_percent = (nextPVI_elevation - PVI_elevation) / (nextPVI_station - PVI_station) * 100;
            }
        }
        if (isNaN(g_out_percent)) g_out_percent = 0;

        let BVC_station, EVC_station, BVC_elevation;
        if (L_curve > 0) {
            BVC_station = PVI_station - L_curve / 2;
            EVC_station = PVI_station + L_curve / 2;
            BVC_elevation = PVI_elevation - (g_in_percent / 100) * (L_curve / 2);
        } else {
            BVC_station = PVI_station;
            EVC_station = PVI_station;
            BVC_elevation = PVI_elevation;
        }

        const A_percent = g_out_percent - g_in_percent;

        let lowHighPoint = null;
        if (L_curve > 0 && A_percent !== 0) {
            const x_low_high = (-g_in_percent / A_percent) * L_curve;
            if (x_low_high >= 0 && x_low_high <= L_curve) {
                const lowHighStation = BVC_station + x_low_high;
                const lowHighElevation = BVC_elevation + (g_in_percent / 100) * x_low_high + (A_percent / 100 / (2 * L_curve)) * x_low_high * x_low_high;
                lowHighPoint = { station: lowHighStation, elevation: lowHighElevation, type: A_percent > 0 ? 'Low Point' : 'High Point' };
            }
        }

        return {
            ...pvi,
            L_curve, PVI_station, PVI_elevation,
            BVC_station, EVC_station, BVC_elevation,
            g_in_percent, g_out_percent, A_percent, lowHighPoint
        };
    });

    let minOverallStation = 0;
    let maxOverallStation = 1000;

    if (pviDetails.length > 0) {
        minOverallStation = pviDetails.reduce((min, p) => Math.min(min, p.BVC_station), pviDetails[0].BVC_station) - 200;
        maxOverallStation = pviDetails.reduce((max, p) => Math.max(max, p.EVC_station), pviDetails[0].EVC_station) + 200;
    } else if (profile.beginningGrade !== '' || profile.endingGrade !== '') {
        minOverallStation = 0;
        maxOverallStation = 1000;
    }
    if (minOverallStation < 0) { // Ensure plot doesn't start before station 0
        minOverallStation = 0;
    }


    let lastPointStation = minOverallStation;
    let lastPointElevation;
    const parsedBeginningGrade = parseFloat(profile.beginningGrade);

    if (pviDetails.length > 0) {
        const firstPVIDetail = pviDetails[0];
        const initialGrade = !isNaN(parsedBeginningGrade) ? parsedBeginningGrade : 0;
        lastPointElevation = getTangentElevation(firstPVIDetail.BVC_station, firstPVIDetail.BVC_elevation, initialGrade, minOverallStation);
    } else if (!isNaN(parsedBeginningGrade)) {
        lastPointElevation = 100; // Default starting elevation if only beginning grade
    } else {
        lastPointElevation = 0; // Default if no PVI and no beginning grade
    }
    if(isNaN(lastPointElevation)) lastPointElevation = 0; // Fallback
    profilePointsForDrawing.push({ station: lastPointStation, elevation: lastPointElevation });

    for (let i = 0; i < pviDetails.length; i++) {
        const pvi = pviDetails[i];
        if (pvi.BVC_station > lastPointStation) {
            const tangentStartStation = lastPointStation;
            const tangentStartElevation = lastPointElevation;
            const stationDiff = pvi.BVC_station - tangentStartStation;
            const tangentGrade = stationDiff === 0 ? 0 : (pvi.BVC_elevation - tangentStartElevation) / stationDiff * 100;
            for (let s = tangentStartStation + plotStep; s < pvi.BVC_station; s += plotStep) {
                profilePointsForDrawing.push({ station: s, elevation: getTangentElevation(tangentStartStation, tangentStartElevation, tangentGrade, s) });
            }
            profilePointsForDrawing.push({ station: pvi.BVC_station, elevation: pvi.BVC_elevation });
        }

        if (pvi.L_curve > 0) {
            for (let s = pvi.BVC_station; s < pvi.EVC_station; s += plotStep) {
                const x = s - pvi.BVC_station;
                const elevation = pvi.BVC_elevation + (pvi.g_in_percent / 100) * x + (pvi.A_percent / 100 / (2 * pvi.L_curve)) * x * x;
                profilePointsForDrawing.push({ station: s, elevation });
            }
            const evcElevationOnTangent = getTangentElevation(pvi.PVI_station, pvi.PVI_elevation, pvi.g_out_percent, pvi.EVC_station);
            profilePointsForDrawing.push({ station: pvi.EVC_station, elevation: evcElevationOnTangent });
            lastPointStation = pvi.EVC_station;
            lastPointElevation = evcElevationOnTangent;
        } else {
            profilePointsForDrawing.push({ station: pvi.PVI_station, elevation: pvi.PVI_elevation });
            lastPointStation = pvi.PVI_station;
            lastPointElevation = pvi.PVI_elevation;
        }
        if(isNaN(lastPointElevation)) lastPointElevation = pvi.PVI_elevation; // Fallback
    }

    const parsedEndingGrade = parseFloat(profile.endingGrade);
    if (lastPointStation < maxOverallStation) {
        const finalGrade = !isNaN(parsedEndingGrade) ? parsedEndingGrade : (!isNaN(parsedBeginningGrade) && pviDetails.length === 0 ? parsedBeginningGrade : 0);
        for (let s = lastPointStation + plotStep; s <= maxOverallStation; s += plotStep) {
            profilePointsForDrawing.push({ station: s, elevation: getTangentElevation(lastPointStation, lastPointElevation, finalGrade, s) });
        }
    } else if (pviDetails.length === 0 && (!isNaN(parsedBeginningGrade) || !isNaN(parsedEndingGrade))) {
      if (profilePointsForDrawing.length <= 1) { // Only initial point exists
          if(profilePointsForDrawing.length > 0) profilePointsForDrawing.pop();
          const gradeToUse = !isNaN(parsedEndingGrade) ? parsedEndingGrade : (!isNaN(parsedBeginningGrade) ? parsedBeginningGrade : 0);
          const startElev = !isNaN(parsedBeginningGrade) ? 100 : 0;
          if(profilePointsForDrawing.length === 0) profilePointsForDrawing.push({station: minOverallStation, elevation: startElev});

          for (let s = minOverallStation + plotStep; s <= maxOverallStation; s += plotStep) {
              profilePointsForDrawing.push({ station: s, elevation: getTangentElevation(minOverallStation, startElev, gradeToUse, s) });
          }
      }
  }

    profilePointsForDrawing.sort((a, b) => a.station - b.station);
    const uniqueProfilePoints = [];
    if (profilePointsForDrawing.length > 0) {
      uniqueProfilePoints.push(profilePointsForDrawing[0]);
      for (let i = 1; i < profilePointsForDrawing.length; i++) {
        const prev = uniqueProfilePoints[uniqueProfilePoints.length - 1];
        const curr = profilePointsForDrawing[i];
        if (curr.station !== prev.station || Math.abs(curr.elevation - prev.elevation) > 0.001) {
          if(!isNaN(curr.elevation)) uniqueProfilePoints.push(curr); // Only add if elevation is valid
        }
      }
    }

    if (uniqueProfilePoints.length < 2) return;

    const allStations = uniqueProfilePoints.map(p => p.station);
    const allElevations = uniqueProfilePoints.map(p => p.elevation).filter(e => !isNaN(e)); // Filter out NaN elevations for range calculation
    if(allElevations.length === 0) return; // Not enough valid points

    const minStation = Math.min(...allStations);
    const maxStation = Math.max(...allStations);
    const minElevation = Math.min(...allElevations);
    const maxElevation = Math.max(...allElevations);

    const stationRange = maxStation - minStation;
    const elevationRange = maxElevation - minElevation;

    const displayMinStation = minStation - (stationRange === 0 ? 50 : stationRange * 0.05);
    const displayMaxStation = maxStation + (stationRange === 0 ? 50 : stationRange * 0.05);
    const displayMinElevation = minElevation - (elevationRange === 0 ? 5 : elevationRange * 0.1);
    const displayMaxElevation = maxElevation + (elevationRange === 0 ? 5 : elevationRange * 0.1);

    if (displayMaxStation - displayMinStation === 0 || displayMaxElevation - displayMinElevation === 0) return; // Avoid division by zero for scale

    const scaleX = canvas.width / (displayMaxStation - displayMinStation);
    const scaleY = canvas.height / (displayMaxElevation - displayMinElevation);

    ctx.beginPath();
    ctx.strokeStyle = '#3B82F6';
    ctx.lineWidth = 2;
    uniqueProfilePoints.forEach((p, i) => {
      if(isNaN(p.elevation)) return; // Skip drawing if elevation is NaN
      const x = (p.station - displayMinStation) * scaleX;
      const y = canvas.height - ((p.elevation - displayMinElevation) * scaleY);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = '#EF4444';
    profile.pvis.forEach(pviInput => {
      const pviStation = parseFloat(pviInput.station);
      const pviElevation = parseFloat(pviInput.elevation);
      if (isNaN(pviStation) || isNaN(pviElevation)) return;
      const x = (pviStation - displayMinStation) * scaleX;
      const y = canvas.height - ((pviElevation - displayMinElevation) * scaleY);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#000000';
      ctx.font = '10px Inter';
      ctx.textAlign = 'left';
      ctx.fillText(`PVI Sta: ${formatNumber(pviStation,0)}`, x + 10, y - 5);
      ctx.fillText(`Elev: ${formatNumber(pviElevation)}`, x + 10, y + 10);
    });

    pviDetails.forEach(pvi => {
      if (!isNaN(pvi.L_curve) && pvi.L_curve > 0) {
        ctx.fillStyle = '#10B981';
        let x_bvc = (pvi.BVC_station - displayMinStation) * scaleX;
        let y_bvc = canvas.height - ((pvi.BVC_elevation - displayMinElevation) * scaleY);
        if(!isNaN(pvi.BVC_elevation)) {
            ctx.beginPath();
            ctx.arc(x_bvc, y_bvc, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#000000';
            ctx.fillText(`BVC Sta: ${formatNumber(pvi.BVC_station, 0)}`, x_bvc + 8, y_bvc - 5);
            ctx.fillText(`Elev: ${formatNumber(pvi.BVC_elevation)}`, x_bvc + 8, y_bvc + 10);
        }

        const evc_tangent_elevation = getTangentElevation(pvi.PVI_station, pvi.PVI_elevation, pvi.g_out_percent, pvi.EVC_station);
        let x_evc = (pvi.EVC_station - displayMinStation) * scaleX;
        let y_evc = canvas.height - ((evc_tangent_elevation - displayMinElevation) * scaleY);
        if(!isNaN(evc_tangent_elevation)) {
            ctx.fillStyle = '#10B981';
            ctx.beginPath();
            ctx.arc(x_evc, y_evc, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#000000';
            ctx.textAlign = 'right';
            ctx.fillText(`EVC Sta: ${formatNumber(pvi.EVC_station, 0)}`, x_evc - 8, y_evc - 5);
            ctx.fillText(`Elev: ${formatNumber(evc_tangent_elevation)}`, x_evc - 8, y_evc + 10);
            ctx.textAlign = 'left';
        }

        if (pvi.lowHighPoint && !isNaN(pvi.lowHighPoint.elevation)) {
            let x_lh = (pvi.lowHighPoint.station - displayMinStation) * scaleX;
            let y_lh = canvas.height - ((pvi.lowHighPoint.elevation - displayMinElevation) * scaleY);
            ctx.fillStyle = '#9D174D';
            ctx.beginPath();
            ctx.arc(x_lh, y_lh, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#000000';
            ctx.fillText(`${pvi.lowHighPoint.type} Sta: ${formatNumber(pvi.lowHighPoint.station, 0)}`, x_lh + 8, y_lh - 5);
            ctx.fillText(`Elev: ${formatNumber(pvi.lowHighPoint.elevation)}`, x_lh + 8, y_lh + 10);
        }
      }
    });

    // Draw Grade Labels on tangents
    ctx.fillStyle = '#000000';
    ctx.font = '12px Inter';
    ctx.textAlign = 'center';

    if (pviDetails.length === 0) {
        // Case: No PVIs, draw a single grade label for the effective grade of the line.
        const beginningGradeVal = parseFloat(profile.beginningGrade);
        const endingGradeVal = parseFloat(profile.endingGrade);
        const startElevForLine = (!isNaN(beginningGradeVal) ? 100 : 0);
        let effectiveGradeToLabel = null;

        if (!isNaN(endingGradeVal)) {
            effectiveGradeToLabel = endingGradeVal;
        } else if (!isNaN(beginningGradeVal)) {
            effectiveGradeToLabel = beginningGradeVal;
        }

        if (effectiveGradeToLabel !== null) {
            const midStation = (minOverallStation + maxOverallStation) / 2;
            const midElevation = getTangentElevation(minOverallStation, startElevForLine, effectiveGradeToLabel, midStation);
            if (!isNaN(midElevation)) {
                const x_mid = (midStation - displayMinStation) * scaleX;
                const y_mid = canvas.height - ((midElevation - displayMinElevation) * scaleY);
                if (isFinite(x_mid) && isFinite(y_mid)) {
                    ctx.fillText(`${formatNumber(effectiveGradeToLabel, 2)}%`, x_mid, y_mid - 10);
                }
            }
        }
    } else {
        // Case: PVIs exist. Draw beginning, between, and ending grade labels.
        const beginningGradeVal = parseFloat(profile.beginningGrade);
        if (!isNaN(beginningGradeVal)) {
            const firstPVIDetail = pviDetails[0];
            if (firstPVIDetail.BVC_station > minOverallStation) { // Ensure there's a segment to label
                const midStation = (minOverallStation + firstPVIDetail.BVC_station) / 2;
                const startElevationForLabelTangent = getTangentElevation(firstPVIDetail.BVC_station, firstPVIDetail.BVC_elevation, beginningGradeVal, minOverallStation);
                const midElevation = getTangentElevation(minOverallStation, startElevationForLabelTangent, beginningGradeVal, midStation);
                 if (!isNaN(midElevation)) {
                    const x_mid = (midStation - displayMinStation) * scaleX;
                    const y_mid = canvas.height - ((midElevation - displayMinElevation) * scaleY);
                    if (isFinite(x_mid) && isFinite(y_mid)) {
                        ctx.fillText(`${formatNumber(beginningGradeVal, 2)}%`, x_mid, y_mid - 10);
                    }
                }
            }
        }

        for (let i = 0; i < pviDetails.length - 1; i++) {
            const pvi1 = pviDetails[i];
            const pvi2 = pviDetails[i+1];
            if (!isNaN(pvi1.g_out_percent) && pvi2.BVC_station > pvi1.EVC_station) {
                const midStation = (pvi1.EVC_station + pvi2.BVC_station) / 2;
                const evc1_tangent_elev = getTangentElevation(pvi1.PVI_station, pvi1.PVI_elevation, pvi1.g_out_percent, pvi1.EVC_station);
                const midElevation = getTangentElevation(pvi1.EVC_station, evc1_tangent_elev, pvi1.g_out_percent, midStation);
                if (!isNaN(midElevation)) {
                    const x_mid = (midStation - displayMinStation) * scaleX;
                    const y_mid = canvas.height - ((midElevation - displayMinElevation) * scaleY);
                    if (isFinite(x_mid) && isFinite(y_mid)) {
                        ctx.fillText(`${formatNumber(pvi1.g_out_percent, 2)}%`, x_mid, y_mid - 10);
                    }
                }
            }
        }
        const endingGradeVal = parseFloat(profile.endingGrade);
        if (!isNaN(endingGradeVal)) {
            const lastPVIDetail = pviDetails[pviDetails.length - 1];
            if (maxOverallStation > lastPVIDetail.EVC_station) { // Ensure there's a segment to label
                const midStation = (lastPVIDetail.EVC_station + maxOverallStation) / 2;
                const evc_last_tangent_elevation = getTangentElevation(lastPVIDetail.PVI_station, lastPVIDetail.PVI_elevation, lastPVIDetail.g_out_percent, lastPVIDetail.EVC_station);
                const midElevation = getTangentElevation(lastPVIDetail.EVC_station, evc_last_tangent_elevation, endingGradeVal, midStation);
                if (!isNaN(midElevation)) {
                    const x_mid = (midStation - displayMinStation) * scaleX;
                    const y_mid = canvas.height - ((midElevation - displayMinElevation) * scaleY);
                    if (isFinite(x_mid) && isFinite(y_mid)) {
                        ctx.fillText(`${formatNumber(endingGradeVal, 2)}%`, x_mid, y_mid - 10);
                    }
                }
            }
        }
    }
    ctx.textAlign = 'left'; // Reset text align

  }, [profile]);

  useEffect(() => {
    drawProfile();
    const handleResize = () => drawProfile();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [profile, drawProfile]);

  const handleProfileChange = (e) => {
    const { name, value } = e.target;
    setProfile(prev => ({ ...prev, [name]: value === '' ? '' : (parseFloat(value) || (value === '0' ? 0 : parseFloat(value) || '')) })); // Allow 0, treat invalid as empty
  };

  const handlePVIChange = (index, e) => {
    const { name, value } = e.target;
    setProfile(prev => {
      const newPVIs = [...prev.pvis];
      newPVIs[index] = { ...newPVIs[index], [name]: value === '' ? '' : (parseFloat(value) || (value === '0' ? 0 : parseFloat(value) || '')) };
      return { ...prev, pvis: newPVIs };
    });
  };

  return (
    <div className="p-4 sm:p-6 bg-white rounded-lg shadow-md mb-6">
      <h2 className="text-xl sm:text-2xl font-bold text-gray-800 mb-4">1. Profile Definition</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div>
          <label htmlFor="beginningGrade" className="block text-sm font-medium text-gray-700">Beginning Grade (%)</label>
          <input
            type="number"
            step="any"
            id="beginningGrade"
            name="beginningGrade"
            value={profile.beginningGrade}
            onChange={handleProfileChange}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2"
          />
        </div>
        <div>
          <label htmlFor="endingGrade" className="block text-sm font-medium text-gray-700">Ending Grade (%)</label>
          <input
            type="number"
            step="any"
            id="endingGrade"
            name="endingGrade"
            value={profile.endingGrade}
            onChange={handleProfileChange}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2"
          />
        </div>
      </div>

      <h3 className="text-lg sm:text-xl font-semibold text-gray-800 mb-3">PVI Points</h3>
      {profile.pvis.map((pvi, index) => (
        <div key={index} className="grid grid-cols-1 md:grid-cols-4 gap-4 bg-gray-50 p-4 rounded-md mb-4 items-end">
          <p className="col-span-full text-md sm:text-lg font-medium text-blue-700">PVI {index + 1}</p>
          <div>
            <label className="block text-sm font-medium text-gray-700">Station</label>
            <input
              type="number"
              step="any"
              name="station"
              value={pvi.station}
              onChange={(e) => handlePVIChange(index, e)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Elevation</label>
            <input
              type="number"
              step="any"
              name="elevation"
              value={pvi.elevation}
              onChange={(e) => handlePVIChange(index, e)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Curve Length (ft)</label>
            <input
              type="number"
              step="any"
              name="length"
              value={pvi.length}
              onChange={(e) => handlePVIChange(index, e)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={() => removePVI(index)}
              className="px-3 py-2 bg-red-500 text-white rounded-md hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 w-full text-sm"
            >
              Remove PVI
            </button>
          </div>
        </div>
      ))}
      <button
        onClick={addPVI}
        className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 mt-4 text-sm"
      >
        Add PVI Point
      </button>

      <div className="mt-8 p-4 bg-blue-50 rounded-lg">
        <h3 className="text-lg sm:text-xl font-semibold text-blue-800 mb-3">Vertical Profile Visual</h3>
        <canvas ref={canvasRef} width={800} height={300} className="bg-white border border-gray-300 rounded-md w-full max-w-full h-auto aspect-[8/3]"></canvas>
        <p className="text-xs sm:text-sm text-blue-700 mt-2">Note: This visual includes parabolic vertical curves based on PVI length and adjacent grades, with labels for PVI, BVC/EVC, Low/High points, and tangent grades.</p>
      </div>
    </div>
  );
};

// Inlet Input Component
const InletInput = ({
  inlet,
  index,
  handleInletChange,
  removeInlet,
  rainfallRegion,
  returnPeriod,
  prevBypassQ,
  displayMessage
}) => {
  const {
    strId,
    structureType,
    station,
    areaEnteringInlet,
    runoffCoefficient,
    longestFlowPath,
    slopeOfFlowPath,
    gutterGrade,
    isLowPoint,
    interceptionRatio,
    manualQi,
    manualWidthOfFlooding,
  } = inlet;

  const tc = useMemo(() => calculateTC(parseFloat(longestFlowPath), parseFloat(runoffCoefficient), parseFloat(slopeOfFlowPath)), [longestFlowPath, runoffCoefficient, slopeOfFlowPath]);
  const intensity = useMemo(() => calculateIntensity(tc, rainfallRegion, returnPeriod), [tc, rainfallRegion, returnPeriod]);
  const qEnteringFromArea = useMemo(() => calculateQ(intensity, parseFloat(areaEnteringInlet)), [intensity, areaEnteringInlet]);
  const qTotal = useMemo(() => qEnteringFromArea + prevBypassQ, [qEnteringFromArea, prevBypassQ]);

  const widthOfFloodingCalculated = useMemo(() => {
    const qTotalNum = parseFloat(qTotal);
    const gutterGradeNum = parseFloat(gutterGrade);
    if (isLowPoint || qTotalNum <= 0 || gutterGradeNum <= 0) return 0;
    return calculateWidthOfFlooding(qTotalNum, gutterGradeNum, 0.025);
  }, [qTotal, gutterGrade, isLowPoint]);

  const qi = useMemo(() => {
    const qTotalNum = parseFloat(qTotal);
    const manualQiNum = parseFloat(manualQi);
    const interceptionRatioNum = parseFloat(interceptionRatio);
    return isLowPoint ? (manualQiNum || 0) : (qTotalNum * (interceptionRatioNum || 0));
  }, [isLowPoint, manualQi, qTotal, interceptionRatio]);

  const qBypass = useMemo(() => parseFloat(qTotal) - qi, [qTotal, qi]); // Ensure qi is subtracted from numeric qTotal

  const widthOfFloodingOutput = useMemo(() => {
    const manualWidthNum = parseFloat(manualWidthOfFlooding);
    return isLowPoint ? (manualWidthNum || 0) : widthOfFloodingCalculated;
  }, [isLowPoint, manualWidthOfFlooding, widthOfFloodingCalculated]);

  const suggestInletType = async () => {
    const qTotalNum = parseFloat(qTotal);
    const gutterGradeNum = parseFloat(gutterGrade);

    if (isNaN(qTotalNum) || qTotalNum <= 0 || isNaN(gutterGradeNum) ) { // gutterGrade can be 0 for sag
        displayMessage("Please ensure 'Q Total' is a positive value and 'Gutter Grade' is valid before suggesting an inlet type.");
        return;
    }
    displayMessage('Getting inlet type suggestion from Gemini API...');
    const prompt = `Given the following hydraulic parameters for a roadway storm drain inlet:
    - Total Flow (Q Total) approaching the inlet: ${formatNumber(qTotalNum)} cfs
    - Longitudinal Gutter Grade at inlet: ${formatNumber(gutterGradeNum)} %
    - Calculated/Allowed Width of Flooding (Spread): ${formatNumber(widthOfFloodingOutput)} ft
    - Is the inlet at a Low Point (Sag): ${isLowPoint ? 'Yes' : 'No'}

    Based on typical civil engineering hydraulic design principles (e.g., from a hydraulics manual like LADOTD or HEC-22), suggest the most suitable *general type* of inlet from these options:
    1.  **Curb-Opening Inlet (e.g., LADOTD CB-06 like)**: Good for continuous grades, less prone to clogging.
    2.  **Grate Inlet (e.g., LADOTD CB-07 like)**: Efficient interception, but can clog.
    3.  **Combination Inlet (Grate + Curb Opening, e.g., LADOTD CB-08 like)**: High capacity, good for sags or high flow.

    Provide the suggested type and a brief (1-2 sentences) reasoning. Consider factors like flow rate, grade, and if it's a sag location.`;

    try {
      let chatHistory = [];
      chatHistory.push({ role: "user", parts: [{ text: prompt }] });
      const payload = { contents: chatHistory };
      // IMPORTANT: For client-side API calls, the API key would be exposed.
      // For production, use a backend function (like a Firebase Function) to make this call securely.
      // Vite environment variables (VITE_GEMINI_API_KEY) can be used for development/build time.
      const apiKey = import.meta.env.VITE_GEMINI_API_KEY || ""; // Fallback to empty if not set
      if (!apiKey) {
        displayMessage("Gemini API key is not configured. Please set VITE_GEMINI_API_KEY in your .env file for this feature.");
        // Optionally, you could still try the call and let the API handle the missing key error,
        // but it's better to inform the user if it's known to be missing.
        // For now, we'll proceed, and the API will likely return an error.
      }
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: { message: "Unknown API error" } })); // Try to parse error, fallback
        throw new Error(`API request failed with status ${response.status}: ${errorData.error?.message || response.statusText}`);
      }
      const result = await response.json();
      if (result.candidates && result.candidates.length > 0 &&
          result.candidates[0].content && result.candidates[0].content.parts &&
          result.candidates[0].content.parts.length > 0) {
        const text = result.candidates[0].content.parts[0].text;
        displayMessage(`Gemini API Suggestion:\n\n${text}`);
      } else {
        let errorMessage = 'Failed to get a suggestion from Gemini API. The response was empty or malformed.';
        if (result.promptFeedback && result.promptFeedback.blockReason) {
            errorMessage += `\nReason: ${result.promptFeedback.blockReason}`;
             if (result.promptFeedback.safetyRatings) {
                errorMessage += `\nSafety Ratings: ${JSON.stringify(result.promptFeedback.safetyRatings)}`;
            }
        } else if (result.error) {
            errorMessage += `\nError: ${result.error.message}`;
        }
        displayMessage(errorMessage);
      }
    } catch (error) {
      console.error('Error calling Gemini API:', error);
      displayMessage(`An error occurred while fetching suggestion: ${error.message}. Check console for details.`);
    }
  };

  useEffect(() => {
    handleInletChange(index, {
      tc,
      intensity,
      qEnteringFromArea,
      qTotal,
      qi,
      qBypass,
      widthOfFloodingOutput,
    }, true);
  }, [tc, intensity, qEnteringFromArea, qTotal, qi, qBypass, widthOfFloodingOutput, index, handleInletChange]);


  return (
    <div className="p-4 sm:p-6 bg-white rounded-lg shadow-md mb-6 border border-blue-200">
      <h3 className="text-lg sm:text-xl font-bold text-blue-700 mb-4">Inlet {index + 1}</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Structure ID</label>
          <input
            type="text"
            name="strId"
            value={strId}
            onChange={(e) => handleInletChange(index, e)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Structure Type</label>
          <select
            name="structureType"
            value={structureType}
            onChange={(e) => handleInletChange(index, e)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2"
          >
            <option value="">Select Type</option>
            <option value="CB-06">CB-06 (Curb)</option>
            <option value="CB-07">CB-07 (Grate)</option>
            <option value="CB-08">CB-08 (Combo)</option>
            <option value="Other">Other</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Station</label>
          <input
            type="number"
            step="any"
            name="station"
            value={station}
            onChange={(e) => handleInletChange(index, e)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Sum of (Area * C) (ΣAC)</label>
          <input
            type="number"
            step="any"
            name="areaEnteringInlet"
            value={areaEnteringInlet}
            onChange={(e) => handleInletChange(index, e)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2"
          />
          <p className="text-xs text-gray-500 mt-1">Σ(Area * Runoff Coeff.) for this inlet's direct drainage.</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Runoff Coeff. (C) <span className="text-xs">(for TC calc)</span></label>
          <input
            type="number"
            step="any"
            name="runoffCoefficient"
            value={runoffCoefficient}
            onChange={(e) => handleInletChange(index, e)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2"
          />
          <p className="text-xs text-gray-500 mt-1">Weighted C for the longest flow path area.</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Longest Flow Path (HL) (ft)</label>
          <input
            type="number"
            step="any"
            name="longestFlowPath"
            value={longestFlowPath}
            onChange={(e) => handleInletChange(index, e)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Slope of Flow Path (S) (%)</label>
          <input
            type="number"
            step="any"
            name="slopeOfFlowPath"
            value={slopeOfFlowPath}
            onChange={(e) => handleInletChange(index, e)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Gutter Grade (%)</label>
          <input
            type="number"
            step="any"
            name="gutterGrade"
            value={gutterGrade}
            onChange={(e) => handleInletChange(index, e)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2"
          />
          <p className="text-xs text-gray-500 mt-1">Longitudinal roadway slope at inlet.</p>
        </div>
        <div className="col-span-full md:col-span-1 flex items-center">
          <label className="inline-flex items-center text-gray-700">
            <input
              type="checkbox"
              name="isLowPoint"
              checked={Boolean(isLowPoint)} // Ensure checked is always boolean
              onChange={(e) => handleInletChange(index, e)}
              className="form-checkbox h-5 w-5 text-blue-600 rounded"
            />
            <span className="ml-2 text-sm font-medium">Is Low Point (Sag)?</span>
          </label>
        </div>
        {isLowPoint && (
             <p className="col-span-full text-xs text-red-500 -mt-2 mb-2">
                For low points, Qi and Width of Flooding are typically from charts (e.g., LADOTD Fig 8-A.8-5). Input manually below.
             </p>
        )}
        {!isLowPoint && (
          <div>
            <label className="block text-sm font-medium text-gray-700">Interception Ratio (Qi/Q)</label>
            <input
              type="number"
              step="any"
              name="interceptionRatio"
              value={interceptionRatio}
              onChange={(e) => handleInletChange(index, e)}
              min="0"
              max="1"
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2"
            />
            <p className="text-xs text-red-600 mt-1">
              From charts (e.g., Fig 8-A.8-1 to 8-A.8-4) or manufacturer data. Input manually.
            </p>
          </div>
        )}
        {isLowPoint && (
          <>
            <div>
              <label className="block text-sm font-medium text-gray-700">Manual Qi (Intercepted Flow) (cfs)</label>
              <input
                type="number"
                step="any"
                name="manualQi"
                value={manualQi}
                onChange={(e) => handleInletChange(index, e)}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Manual Width of Flooding (ft)</label>
              <input
                type="number"
                step="any"
                name="manualWidthOfFlooding"
                value={manualWidthOfFlooding}
                onChange={(e) => handleInletChange(index, e)}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2"
              />
            </div>
          </>
        )}
      </div>

      <div className="mt-6 pt-4 border-t border-gray-200">
        <h4 className="text-md sm:text-lg font-semibold text-gray-800 mb-3">Calculated Outputs for Inlet {index + 1}:</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-2 text-sm">
          <div className="p-2 bg-gray-50 rounded-md"><span className="font-medium text-gray-600">TC:</span> {formatNumber(tc)} min</div>
          <div className="p-2 bg-gray-50 rounded-md"><span className="font-medium text-gray-600">Intensity:</span> {formatNumber(intensity)} in/hr</div>
          <div className="p-2 bg-gray-50 rounded-md"><span className="font-medium text-gray-600">Q from Area:</span> {formatNumber(qEnteringFromArea)} cfs</div>
          <div className="p-2 bg-gray-50 rounded-md"><span className="font-medium text-gray-600">Q Bypass (Prev):</span> {formatNumber(prevBypassQ)} cfs</div>
          <div className="p-2 bg-blue-100 rounded-md font-semibold"><span className="font-medium text-blue-700">Q Total:</span> {formatNumber(qTotal)} cfs</div>
          <div className="p-2 bg-green-100 rounded-md font-semibold"><span className="font-medium text-green-700">Qi (Intercepted):</span> {formatNumber(qi)} cfs</div>
          <div className="p-2 bg-red-100 rounded-md font-semibold"><span className="font-medium text-red-700">Q Bypass (Current):</span> {formatNumber(qBypass)} cfs</div>
          <div className="p-2 bg-yellow-100 rounded-md font-semibold"><span className="font-medium text-yellow-700">Width of Flooding:</span> {formatNumber(widthOfFloodingOutput)} ft</div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row justify-end mt-6 space-y-2 sm:space-y-0 sm:space-x-2">
        <button
          onClick={suggestInletType}
          className="px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 text-sm w-full sm:w-auto"
        >
          Suggest Inlet Type ✨
        </button>
        <button
          onClick={() => removeInlet(index)}
          className="px-4 py-2 bg-red-500 text-white rounded-md hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 text-sm w-full sm:w-auto"
        >
          Remove Inlet
        </button>
      </div>
    </div>
  );
};

// Summary Report Component
const SummaryReport = ({ profile, inlets, rainfallRegion, returnPeriod }) => {
  return (
    <div className="p-4 sm:p-6 bg-white rounded-lg shadow-md mb-6">
      <h2 className="text-xl sm:text-2xl font-bold text-gray-800 mb-4">3. Summary / Report</h2>
      <div className="mb-6">
        <h3 className="text-lg sm:text-xl font-semibold text-gray-800 mb-3">Profile Definition Summary</h3>
        <p className="text-gray-700 text-sm"><strong>Beginning Grade:</strong> {formatNumber(parseFloat(profile.beginningGrade))} %</p>
        <p className="text-gray-700 text-sm"><strong>Ending Grade:</strong> {formatNumber(parseFloat(profile.endingGrade))} %</p>
        <h4 className="font-medium text-gray-800 mt-2 text-sm">PVI Points:</h4>
        {profile.pvis.length === 0 ? (
          <p className="text-gray-600 italic text-sm">No PVI points defined.</p>
        ) : (
          <ul className="list-disc list-inside ml-4 text-sm">
            {profile.pvis.map((pvi, index) => (
              <li key={index} className="text-gray-700">
                PVI {index + 1}: Sta {pvi.station}, Elev {formatNumber(parseFloat(pvi.elevation))}, Curve Len {formatNumber(parseFloat(pvi.length))} ft
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mb-6">
        <h3 className="text-lg sm:text-xl font-semibold text-gray-800 mb-3">Rainfall Parameters</h3>
        <p className="text-gray-700 text-sm"><strong>Rainfall Region:</strong> {rainfallRegion}</p>
        <p className="text-gray-700 text-sm"><strong>Return Period:</strong> {returnPeriod}</p>
      </div>

      <div>
        <h3 className="text-lg sm:text-xl font-semibold text-gray-800 mb-3">Inlet Calculation Summary</h3>
        {inlets.length === 0 ? (
          <p className="text-gray-600 italic text-sm">No inlets defined.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full bg-white border border-gray-300 rounded-lg text-xs sm:text-sm">
              <thead>
                <tr className="bg-blue-100 text-blue-800">
                  <th className="py-2 px-3 border-b text-left">Inlet #</th>
                  <th className="py-2 px-3 border-b text-left">ID</th>
                  <th className="py-2 px-3 border-b text-left">Type</th>
                  <th className="py-2 px-3 border-b text-right">Sta</th>
                  <th className="py-2 px-3 border-b text-right">ΣAC</th>
                  <th className="py-2 px-3 border-b text-right">HL (ft)</th>
                  <th className="py-2 px-3 border-b text-right">S Path (%)</th>
                  <th className="py-2 px-3 border-b text-right">Gutter S (%)</th>
                  <th className="py-2 px-3 border-b text-right">TC (min)</th>
                  <th className="py-2 px-3 border-b text-right">Intensity (in/hr)</th>
                  <th className="py-2 px-3 border-b text-right">Q Enter (cfs)</th>
                  <th className="py-2 px-3 border-b text-right">Q Bypass Prev (cfs)</th>
                  <th className="py-2 px-3 border-b text-right">Q Total (cfs)</th>
                  <th className="py-2 px-3 border-b text-right">Qi (cfs)</th>
                  <th className="py-2 px-3 border-b text-right">Q Bypass Curr (cfs)</th>
                  <th className="py-2 px-3 border-b text-right">Spread (ft)</th>
                </tr>
              </thead>
              <tbody>
                {inlets.map((inlet, idx) => (
                  <tr key={idx} className="hover:bg-gray-50 text-gray-700">
                    <td className="py-2 px-3 border-b text-left">{idx + 1}</td>
                    <td className="py-2 px-3 border-b text-left">{inlet.strId}</td>
                    <td className="py-2 px-3 border-b text-left">{inlet.structureType}</td>
                    <td className="py-2 px-3 border-b text-right">{formatNumber(parseFloat(inlet.station))}</td>
                    <td className="py-2 px-3 border-b text-right">{formatNumber(parseFloat(inlet.areaEnteringInlet))}</td>
                    <td className="py-2 px-3 border-b text-right">{formatNumber(parseFloat(inlet.longestFlowPath))}</td>
                    <td className="py-2 px-3 border-b text-right">{formatNumber(parseFloat(inlet.slopeOfFlowPath), 2)}</td>
                    <td className="py-2 px-3 border-b text-right">{formatNumber(parseFloat(inlet.gutterGrade), 2)}</td>
                    <td className="py-2 px-3 border-b text-right">{formatNumber(inlet.tc)}</td>
                    <td className="py-2 px-3 border-b text-right">{formatNumber(inlet.intensity)}</td>
                    <td className="py-2 px-3 border-b text-right">{formatNumber(inlet.qEnteringFromArea)}</td>
                    <td className="py-2 px-3 border-b text-right">{formatNumber(idx > 0 ? inlets[idx - 1].qBypass : 0)}</td>
                    <td className="py-2 px-3 border-b text-right font-semibold">{formatNumber(inlet.qTotal)}</td>
                    <td className="py-2 px-3 border-b text-right font-semibold text-green-700">{formatNumber(inlet.qi)}</td>
                    <td className="py-2 px-3 border-b text-right font-semibold text-red-700">{formatNumber(inlet.qBypass)}</td>
                    <td className="py-2 px-3 border-b text-right font-semibold text-yellow-700">{formatNumber(inlet.widthOfFloodingOutput)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

const App = () => {
  const [profile, setProfile] = useState({
    beginningGrade: -1.0,
    endingGrade: -0.4,
    pvis: [
      { station: 10200, elevation: 120.00, length: 400 },
      { station: 10600, elevation: 124.00, length: 400 },
    ],
  });

  const [inlets, setInlets] = useState([
    // ... your initial inlets data ...
    { strId: "INLET-1", structureType: 'CB-06', station: 10105, areaEnteringInlet: 0.19, runoffCoefficient: 1.0, longestFlowPath: 141.42, slopeOfFlowPath: 0.5, gutterGrade: 1.0, isLowPoint: false, interceptionRatio: 0.75, manualQi: '', manualWidthOfFlooding: '', tc: 0, intensity: 0, qEnteringFromArea: 0, qTotal: 0, qi: 0, qBypass: 0, widthOfFloodingOutput: 0, },
    { strId: "INLET-2-SAG", structureType: 'CB-08', station: 10200, areaEnteringInlet: 0.19, runoffCoefficient: 0.95, longestFlowPath: 106.07, slopeOfFlowPath: 0.5, gutterGrade: 0.0, isLowPoint: true, interceptionRatio: '', manualQi: 0.95, manualWidthOfFlooding: 6.9, tc: 0, intensity: 0, qEnteringFromArea: 0, qTotal: 0, qi: 0, qBypass: 0, widthOfFloodingOutput: 0, },
  ]);
  const [rainfallRegion, setRainfallRegion] = useState('Region 1');
  const [returnPeriod, setReturnPeriod] = useState('10-Year');
  const [modalMessage, setModalMessage] = useState('');

  const displayMessage = (message) => setModalMessage(message);
  const closeModal = () => setModalMessage('');
  const addPVI = () => setProfile(prev => ({ ...prev, pvis: [...prev.pvis, { station: '', elevation: '', length: '' }] }));
  const removePVI = (index) => setProfile(prev => ({ ...prev, pvis: prev.pvis.filter((_, i) => i !== index) }));
  const addInlet = () => setInlets(prev => [ ...prev, { strId: `INLET-${prev.length + 1}`, structureType: '', station: '', areaEnteringInlet: '', runoffCoefficient: 0.9, longestFlowPath: '', slopeOfFlowPath: '', gutterGrade: '', isLowPoint: false, interceptionRatio: '', manualQi: '', manualWidthOfFlooding: '', tc: 0, intensity: 0, qEnteringFromArea: 0, qTotal: 0, qi: 0, qBypass: 0, widthOfFloodingOutput: 0, }, ]);
  const handleInletChange = useCallback((index, eOrCalculatedValues, isCalculatedUpdate = false) => {
    setInlets(prevInlets => {
      const newInlets = [...prevInlets];
      if (isCalculatedUpdate) {
        newInlets[index] = { ...newInlets[index], ...eOrCalculatedValues };
      } else {
        const { name, value, type, checked } = eOrCalculatedValues.target;
        let processedValue;
        if (type === 'checkbox') {
            processedValue = checked;
        } else if (type === 'number') {
            if (value === '') {
                processedValue = '';
            } else {
                const num = parseFloat(value);
                processedValue = isNaN(num) ? (value === '0' ? 0 : '') : num;
            }
        } else {
            processedValue = value;
        }
        newInlets[index] = { ...newInlets[index], [name]: processedValue, };
      }
      return newInlets;
    });
  }, []);
  const removeInlet = (index) => setInlets(prev => prev.filter((_, i) => i !== index));

  return (
    // This is the main application container. It will be white, on the gray body.
    // ml-0 mr-auto should push it left. Padding is applied INSIDE this block.
    <div className="bg-white text-gray-900 p-2 sm:p-4 md:p-6 lg:p-8 max-w-7xl shadow-lg ml-0 mr-auto">
      {/* min-h-screen removed from here, as body/root handle it. Added bg-white and shadow-lg */}
      {/* Font-sans is inherited from body (via index.css and Tailwind defaults) */}

      <header className="mb-6 sm:mb-8">
        <h1 className="text-2xl sm:text-3xl md:text-4xl font-extrabold text-center text-blue-700">
            Roadway Inlet Spacing Calculator
        </h1>
        <p className="text-center text-sm text-gray-600 mt-1">
            Based on LADOTD Hydraulics Manual principles (Conceptual)
        </p>
      </header>

      {/* Rainfall Parameters Section - styled as part of the main white block */}
      <div className="p-4 sm:p-6 rounded-lg mb-6 border border-gray-200">
        <h2 className="text-xl sm:text-2xl font-bold text-gray-800 mb-4">Rainfall Parameters</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="rainfallRegion" className="block text-sm font-medium text-gray-700">Rainfall Region (LADOTD)</label>
            <select id="rainfallRegion" name="rainfallRegion" value={rainfallRegion} onChange={(e) => setRainfallRegion(e.target.value)} className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2">
              {Object.keys(RAINFALL_COEFFICIENTS).map(region => (
                <option key={region} value={region}>{region}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="returnPeriod" className="block text-sm font-medium text-gray-700">Design Storm Return Period</label>
            <select id="returnPeriod" name="returnPeriod" value={returnPeriod} onChange={(e) => setReturnPeriod(e.target.value)} className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 p-2">
              {Object.keys(RAINFALL_COEFFICIENTS[rainfallRegion] || {}).map(period => (
                <option key={period} value={period}>{period}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">E.g., 10-Year for typical storm drains (LADOTD Ch 8.3).</p>
          </div>
        </div>
      </div>

      {/* ProfileDefinition, InletInput, SummaryReport components are already styled as cards */}
      <ProfileDefinition
        profile={profile}
        setProfile={setProfile}
        addPVI={addPVI}
        removePVI={removePVI}
        displayMessage={displayMessage}
      />

      <div className="p-4 sm:p-6 bg-white rounded-lg shadow-md mb-6"> {/* This container for inlets can keep its card style if desired */}
        <h2 className="text-xl sm:text-2xl font-bold text-gray-800 mb-4">2. Inlet Design & Spacing</h2>
        {inlets.map((inlet, index) => (
          <InletInput
            key={inlet.strId || index}
            inlet={inlet}
            index={index}
            handleInletChange={handleInletChange}
            removeInlet={removeInlet}
            rainfallRegion={rainfallRegion}
            returnPeriod={returnPeriod}
            prevBypassQ={index > 0 ? (parseFloat(inlets[index - 1].qBypass) || 0) : 0}
            displayMessage={displayMessage}
          />
        ))}
        <button
          onClick={addInlet}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 mt-4 text-sm"
        >
          Add Inlet
        </button>
      </div>

      <SummaryReport
        profile={profile}
        inlets={inlets}
        rainfallRegion={rainfallRegion}
        returnPeriod={returnPeriod}
      />

      <Modal message={modalMessage} onClose={closeModal} />

      <footer className="text-center text-xs text-gray-500 mt-8 pb-4">
        <p>&copy; {new Date().getFullYear()} Inlet Spacing Calculator. For conceptual and educational purposes only.</p>
        <p className="mt-1">Always consult official DOTD manuals and professional engineering judgment for actual design.</p>
      </footer>
    </div>
  );
};

export default App;
