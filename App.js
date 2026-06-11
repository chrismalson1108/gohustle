import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { UserProvider } from './src/context/UserContext';
import { JobsProvider } from './src/context/JobsContext';
import AchievementToast from './src/components/AchievementToast';

import HomeScreen      from './src/screens/HomeScreen';
import EarnScreen      from './src/screens/EarnScreen';
import PostJobScreen   from './src/screens/PostJobScreen';
import ProfileScreen   from './src/screens/ProfileScreen';
import JobDetailScreen from './src/screens/JobDetailScreen';

import { colors } from './src/theme';

const Tab   = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const DETAIL_OPTS = {
  headerShown: true,
  title: '',
  headerTransparent: false,
  headerTintColor: colors.primary,
  headerShadowVisible: false,
  headerStyle: { backgroundColor: '#fff' },
};

function HomeStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="HomeMain" component={HomeScreen} />
      <Stack.Screen name="JobDetail" component={JobDetailScreen} options={DETAIL_OPTS} />
    </Stack.Navigator>
  );
}

function EarnStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="EarnMain" component={EarnScreen} />
      <Stack.Screen name="JobDetail" component={JobDetailScreen} options={DETAIL_OPTS} />
    </Stack.Navigator>
  );
}

const TAB_ICONS = {
  HomeTab:    ['home',         'home-outline'],
  EarnTab:    ['flash',        'flash-outline'],
  PostTab:    ['add-circle',   'add-circle-outline'],
  ProfileTab: ['person-circle','person-circle-outline'],
};

export default function App() {
  return (
    <SafeAreaProvider>
    <UserProvider>
      <JobsProvider>
        <View style={{ flex: 1, position: 'relative' }}>
          <NavigationContainer>
            <Tab.Navigator
              screenOptions={({ route }) => ({
                headerShown: false,
                tabBarIcon: ({ focused, color, size }) => {
                  const [on, off] = TAB_ICONS[route.name] || ['ellipse', 'ellipse-outline'];
                  return <Ionicons name={focused ? on : off} size={size} color={color} />;
                },
                tabBarActiveTintColor: colors.primary,
                tabBarInactiveTintColor: colors.textMuted,
                tabBarStyle: {
                  backgroundColor: '#fff',
                  borderTopColor: colors.border,
                  paddingBottom: 6,
                  height: 64,
                },
                tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
              })}
            >
              <Tab.Screen name="HomeTab"    component={HomeStack}    options={{ title: 'Browse' }} />
              <Tab.Screen name="EarnTab"    component={EarnStack}    options={{ title: 'Earn' }} />
              <Tab.Screen name="PostTab"    component={PostJobScreen} options={{ title: 'Post' }} />
              <Tab.Screen name="ProfileTab" component={ProfileScreen} options={{ title: 'Profile' }} />
            </Tab.Navigator>
          </NavigationContainer>
          <AchievementToast />
        </View>
      </JobsProvider>
    </UserProvider>
    </SafeAreaProvider>
  );
}
